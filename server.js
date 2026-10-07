const express = require("express");
const axios = require("axios");
const path = require("path");
require("dotenv").config();

const app = express();

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

const ENV = process.env.MPESA_ENV || "sandbox";

const BASE_URL =
  ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const FIXED_AMOUNT = 35000;

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| SERVE FRONTEND
|--------------------------------------------------------------------------
|
| This fixes:
|
| Cannot GET /
|
*/

app.use(express.static(path.join(__dirname, "public")));

/*
|--------------------------------------------------------------------------
| HOME PAGE
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "WorkAway International payment server is running.",
    environment: ENV,
    timestamp: new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| M-PESA ACCESS TOKEN
|--------------------------------------------------------------------------
*/

async function generateToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      "MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET is missing."
    );
  }

  const auth = Buffer.from(
    `${consumerKey}:${consumerSecret}`
  ).toString("base64");

  const response = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      },
      timeout: 15000
    }
  );

  if (
    !response.data ||
    !response.data.access_token
  ) {
    throw new Error(
      "Safaricom did not return an access token."
    );
  }

  return response.data.access_token;
}

/*
|--------------------------------------------------------------------------
| TIMESTAMP
|--------------------------------------------------------------------------
*/

function getTimestamp() {
  const date = new Date();

  return (
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0") +
    String(date.getHours()).padStart(2, "0") +
    String(date.getMinutes()).padStart(2, "0") +
    String(date.getSeconds()).padStart(2, "0")
  );
}

/*
|--------------------------------------------------------------------------
| M-PESA PASSWORD
|--------------------------------------------------------------------------
*/

function getPassword(
  shortCode,
  passkey,
  timestamp
) {
  return Buffer.from(
    `${shortCode}${passkey}${timestamp}`
  ).toString("base64");
}

/*
|--------------------------------------------------------------------------
| PHONE NUMBER FORMAT
|--------------------------------------------------------------------------
*/

function formatPhoneNumber(phoneNumber) {
  let phone = String(phoneNumber)
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\+/, "");

  if (phone.startsWith("0")) {
    phone = `254${phone.substring(1)}`;
  }

  if (phone.startsWith("7")) {
    phone = `254${phone}`;
  }

  if (!/^254\d{9}$/.test(phone)) {
    throw new Error(
      "Invalid Kenyan phone number. Use 0712345678 or 254712345678."
    );
  }

  return phone;
}

/*
|--------------------------------------------------------------------------
| STK PUSH
|--------------------------------------------------------------------------
*/

app.post("/api/stkpush", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required."
      });
    }

    const formattedPhone =
      formatPhoneNumber(phoneNumber);

    const shortCode =
      process.env.MPESA_SHORTCODE;

    const passkey =
      process.env.MPESA_PASSKEY;

    const callbackUrl =
      process.env.MPESA_CALLBACK_URL;

    if (!shortCode) {
      return res.status(500).json({
        success: false,
        message:
          "MPESA_SHORTCODE is not configured."
      });
    }

    if (!passkey) {
      return res.status(500).json({
        success: false,
        message:
          "MPESA_PASSKEY is not configured."
      });
    }

    if (!callbackUrl) {
      return res.status(500).json({
        success: false,
        message:
          "MPESA_CALLBACK_URL is not configured."
      });
    }

    if (!callbackUrl.startsWith("https://")) {
      return res.status(500).json({
        success: false,
        message:
          "MPESA_CALLBACK_URL must use HTTPS."
      });
    }

    const token = await generateToken();

    const timestamp = getTimestamp();

    const password = getPassword(
      shortCode,
      passkey,
      timestamp
    );

    const payload = {
      BusinessShortCode: shortCode,

      Password: password,

      Timestamp: timestamp,

      TransactionType:
        "CustomerPayBillOnline",

      Amount: FIXED_AMOUNT,

      PartyA: formattedPhone,

      PartyB: shortCode,

      PhoneNumber: formattedPhone,

      CallBackURL: callbackUrl,

      AccountReference:
        "WorkAwayInternational",

      TransactionDesc:
        "WorkAway International Payment"
    };

    console.log(
      "[STK REQUEST]",
      {
        phone: formattedPhone,
        amount: FIXED_AMOUNT,
        environment: ENV
      }
    );

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"
        },

        timeout: 30000
      }
    );

    console.log(
      "[STK RESPONSE]",
      response.data
    );

    return res.status(200).json({
      success: true,

      message:
        response.data.CustomerMessage ||
        `STK prompt sent to ${formattedPhone}. Enter your M-Pesa PIN.`,

      checkoutRequestId:
        response.data.CheckoutRequestID,

      merchantRequestId:
        response.data.MerchantRequestID,

      responseCode:
        response.data.ResponseCode,

      customerMessage:
        response.data.CustomerMessage
    });

  } catch (error) {
    console.error(
      "[STK PUSH ERROR]",
      error.response?.data ||
      error.message
    );

    const mpesaError =
      error.response?.data;

    return res.status(500).json({
      success: false,

      message:
        mpesaError?.errorMessage ||
        mpesaError?.responseDescription ||
        error.message ||
        "Failed to trigger STK Push.",

      details:
        mpesaError || null
    });
  }
});

/*
|--------------------------------------------------------------------------
| STK PUSH QUERY
|--------------------------------------------------------------------------
*/

app.post(
  "/api/stkpush/query",
  async (req, res) => {
    try {
      const {
        checkoutRequestId
      } = req.body;

      if (!checkoutRequestId) {
        return res.status(400).json({
          success: false,
          message:
            "CheckoutRequestID is required."
        });
      }

      const shortCode =
        process.env.MPESA_SHORTCODE;

      const passkey =
        process.env.MPESA_PASSKEY;

      if (!shortCode || !passkey) {
        return res.status(500).json({
          success: false,
          message:
            "M-Pesa shortcode or passkey is not configured."
        });
      }

      const token =
        await generateToken();

      const timestamp =
        getTimestamp();

      const password =
        getPassword(
          shortCode,
          passkey,
          timestamp
        );

      const payload = {
        BusinessShortCode: shortCode,

        Password: password,

        Timestamp: timestamp,

        CheckoutRequestID:
          checkoutRequestId
      };

      const response =
        await axios.post(
          `${BASE_URL}/mpesa/stkpushquery/v1/query`,
          payload,
          {
            headers: {
              Authorization:
                `Bearer ${token}`,

              "Content-Type":
                "application/json"
            },

            timeout: 30000
          }
        );

      console.log(
        "[STK QUERY]",
        response.data
      );

      const resultCode =
        String(
          response.data.ResultCode
        );

      return res.status(200).json({
        success:
          resultCode === "0",

        resultCode:
          response.data.ResultCode,

        resultDesc:
          response.data.ResultDesc,

        data:
          response.data
      });

    } catch (error) {
      console.error(
        "[STK QUERY ERROR]",
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        success: false,

        message:
          error.response?.data
            ?.errorMessage ||
          error.response?.data
            ?.ResultDesc ||
          "Failed to query STK Push status.",

        details:
          error.response?.data ||
          null
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| M-PESA CALLBACK
|--------------------------------------------------------------------------
*/

app.post(
  "/api/mpesa/callback",
  (req, res) => {
    try {
      console.log(
        "[M-PESA CALLBACK RECEIVED]"
      );

      console.log(
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      const callbackData =
        req.body?.Body?.stkCallback;

      if (!callbackData) {
        console.error(
          "[CALLBACK ERROR] Invalid callback format."
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      const resultCode =
        callbackData.ResultCode;

      const resultDesc =
        callbackData.ResultDesc;

      console.log(
        `[M-PESA CALLBACK] ResultCode: ${resultCode}`
      );

      console.log(
        `[M-PESA CALLBACK] ResultDesc: ${resultDesc}`
      );

      /*
      |--------------------------------------------------------------------------
      | SUCCESSFUL PAYMENT
      |--------------------------------------------------------------------------
      */

      if (Number(resultCode) === 0) {
        const metadata =
          callbackData
            .CallbackMetadata
            ?.Item || [];

        const amount =
          metadata.find(
            item =>
              item.Name === "Amount"
          )?.Value;

        const receipt =
          metadata.find(
            item =>
              item.Name ===
              "MpesaReceiptNumber"
          )?.Value;

        const phone =
          metadata.find(
            item =>
              item.Name ===
              "PhoneNumber"
          )?.Value;

        const transactionDate =
          metadata.find(
            item =>
              item.Name ===
              "TransactionDate"
          )?.Value;

        console.log(
          "[PAYMENT SUCCESS]",
          {
            receipt,
            amount,
            phone,
            transactionDate
          }
        );
      }

      /*
      |--------------------------------------------------------------------------
      | FAILED / CANCELLED PAYMENT
      |--------------------------------------------------------------------------
      */

      else {
        console.log(
          "[PAYMENT FAILED]",
          {
            resultCode,
            resultDesc
          }
        );
      }

      /*
      |--------------------------------------------------------------------------
      | ACKNOWLEDGE SAFARICOM
      |--------------------------------------------------------------------------
      */

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });

    } catch (error) {
      console.error(
        "[CALLBACK ERROR]",
        error
      );

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| API 404
|--------------------------------------------------------------------------
*/

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message:
      "API endpoint not found."
  });
});

/*
|--------------------------------------------------------------------------
| GENERAL ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
  (err, req, res, next) => {
    console.error(
      "[EXPRESS ERROR]",
      err
    );

    res.status(500).json({
      success: false,
      message:
        "Internal server error."
    });
  }
);

/*
|--------------------------------------------------------------------------
| VERCEL EXPORT
|--------------------------------------------------------------------------
*/

module.exports = app;
