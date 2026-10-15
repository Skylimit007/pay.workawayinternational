
'use strict';

const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();

/* -------------------------------------------------------------------------- */
/* CONFIGURATION                                                              */
/* -------------------------------------------------------------------------- */

const ENV = String(process.env.MPESA_ENV || 'sandbox')
  .trim()
  .toLowerCase();

if (!['sandbox', 'production'].includes(ENV)) {
  throw new Error('MPESA_ENV must be either "sandbox" or "production".');
}

const BASE_URL = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Fixed payment amount: KSh 35,000.
const FIXED_AMOUNT = 35000;
const REQUEST_TIMEOUT_MS = 30000;

/* -------------------------------------------------------------------------- */
/* MIDDLEWARE                                                                 */
/* -------------------------------------------------------------------------- */

app.disable('x-powered-by');

app.use(express.json({
  limit: '32kb',
  strict: true
}));

app.use(express.urlencoded({
  extended: false,
  limit: '32kb'
}));

app.use(express.static(path.join(__dirname, 'public')));

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function sendError(res, status, message, details = undefined) {
  const body = {
    success: false,
    message
  };

  if (details !== undefined) {
    body.details = details;
  }

  return res.status(status).json(body);
}

function getRequiredEnv(name) {
  return String(process.env[name] || '').trim();
}

function getTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return values.year +
    values.month +
    values.day +
    values.hour +
    values.minute +
    values.second;
}

function getPassword(businessShortCode, passkey, timestamp) {
  return Buffer.from(
    `${businessShortCode}${passkey}${timestamp}`
  ).toString('base64');
}

function formatPhoneNumber(value) {
  let phone = String(value || '')
    .trim()
    .replace(/[\s()-]/g, '')
    .replace(/^\+/, '');

  if (phone.startsWith('0')) {
    phone = `254${phone.slice(1)}`;
  } else if (/^[17]\d{8}$/.test(phone)) {
    phone = `254${phone}`;
  }

  if (!/^254\d{9}$/.test(phone)) {
    throw new Error(
      'Enter a valid Kenyan mobile number, e.g. 0712345678 or 254712345678.'
    );
  }

  return phone;
}

function getCallbackUrl() {
  const callbackUrl = getRequiredEnv('MPESA_CALLBACK_URL');

  if (!callbackUrl) {
    throw new Error('MPESA_CALLBACK_URL is not configured.');
  }

  let parsed;

  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new Error(
      'MPESA_CALLBACK_URL must be a valid public HTTPS URL.'
    );
  }

  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    ['localhost', '127.0.0.1', '0.0.0.0'].includes(
      parsed.hostname.toLowerCase()
    )
  ) {
    throw new Error(
      'MPESA_CALLBACK_URL must be a valid public HTTPS URL.'
    );
  }

  return parsed.toString();
}

function getStoreAndTill() {
  // Store/Head Office Number is used as BusinessShortCode.
  // Customer-facing Buy Goods Till Number is used as PartyB.
  const storeNumber = getRequiredEnv('MPESA_STORE_NUMBER');
  const tillNumber = getRequiredEnv('MPESA_PARTY_B');
  const passkey = getRequiredEnv('MPESA_PASSKEY');

  if (!/^\d+$/.test(storeNumber)) {
    throw new Error(
      'Configure MPESA_STORE_NUMBER with the numeric Store/Head Office number supplied by Safaricom.'
    );
  }

  if (!/^\d+$/.test(tillNumber)) {
    throw new Error(
      'Configure MPESA_PARTY_B with the numeric customer-facing Buy Goods Till Number.'
    );
  }

  if (!passkey) {
    throw new Error('MPESA_PASSKEY is not configured.');
  }

  return {
    storeNumber,
    tillNumber,
    passkey
  };
}

async function generateToken() {
  const consumerKey = getRequiredEnv('MPESA_CONSUMER_KEY');
  const consumerSecret = getRequiredEnv('MPESA_CONSUMER_SECRET');

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      'MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET must both be configured.'
    );
  }

  const auth = Buffer.from(
    `${consumerKey}:${consumerSecret}`
  ).toString('base64');

  const response = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      },
      timeout: 15000
    }
  );

  if (!response.data || !response.data.access_token) {
    throw new Error('Safaricom did not return an access token.');
  }

  return response.data.access_token;
}

function getSafaricomError(error) {
  const data = error && error.response && error.response.data;

  if (data && typeof data === 'object') {
    return data;
  }

  return null;
}

function getSafaricomMessage(data, fallback) {
  if (!data || typeof data !== 'object') {
    return fallback;
  }

  return data.errorMessage ||
    data.ResponseDescription ||
    data.responseDescription ||
    data.ResultDesc ||
    fallback;
}

/* -------------------------------------------------------------------------- */
/* FRONTEND AND HEALTH                                                        */
/* -------------------------------------------------------------------------- */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'WorkAway International payment server is running.',
    environment: ENV,
    timestamp: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* STK PUSH — BUY GOODS                                                       */
/* -------------------------------------------------------------------------- */

app.post('/api/stkpush', async (req, res) => {
  try {
    const phoneInput = req.body && req.body.phoneNumber;

    if (!phoneInput) {
      return sendError(res, 400, 'Phone number is required.');
    }

    let formattedPhone;

    try {
      formattedPhone = formatPhoneNumber(phoneInput);
    } catch (error) {
      return sendError(res, 400, error.message);
    }

    let merchant;
    let callbackUrl;

    try {
      merchant = getStoreAndTill();
      callbackUrl = getCallbackUrl();
    } catch (error) {
      return sendError(res, 500, error.message);
    }

    const {
      storeNumber,
      tillNumber,
      passkey
    } = merchant;

    const token = await generateToken();
    const timestamp = getTimestamp();

    // Password must use the same shortcode as BusinessShortCode.
    const password = getPassword(
      storeNumber,
      passkey,
      timestamp
    );

    const payload = {
      BusinessShortCode: storeNumber,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: FIXED_AMOUNT,
      PartyA: formattedPhone,
      PartyB: tillNumber,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: 'WorkAwayInternational',
      TransactionDesc: 'WorkAway International Payment'
    };

    // Never log credentials, passkey, password, or access token.
    console.log('[STK REQUEST]', {
      phone: formattedPhone,
      amount: FIXED_AMOUNT,
      environment: ENV,
      businessShortCode: storeNumber,
      partyB: tillNumber
    });

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      }
    );

    console.log('[STK RESPONSE]', response.data);

    if (
      String(response.data && response.data.ResponseCode) !== '0'
    ) {
      return sendError(
        res,
        502,
        getSafaricomMessage(
          response.data,
          'Safaricom did not accept the STK Push request.'
        ),
        response.data || null
      );
    }

    return res.status(200).json({
      success: true,
      message: response.data.CustomerMessage ||
        `STK prompt sent to ${formattedPhone}. Enter your M-Pesa PIN.`,
      checkoutRequestId: response.data.CheckoutRequestID,
      merchantRequestId: response.data.MerchantRequestID,
      responseCode: response.data.ResponseCode,
      customerMessage: response.data.CustomerMessage
    });
  } catch (error) {
    const mpesaError = getSafaricomError(error);

    console.error(
      '[STK PUSH ERROR]',
      mpesaError || error.message
    );

    return sendError(
      res,
      502,
      getSafaricomMessage(
        mpesaError,
        'Failed to trigger STK Push. Check the Vercel function logs and Daraja configuration.'
      ),
      mpesaError || undefined
    );
  }
});

/* -------------------------------------------------------------------------- */
/* STK PUSH QUERY                                                             */
/* -------------------------------------------------------------------------- */

app.post('/api/stkpush/query', async (req, res) => {
  try {
    const checkoutRequestId = String(
      (req.body && req.body.checkoutRequestId) || ''
    ).trim();

    if (!checkoutRequestId) {
      return sendError(
        res,
        400,
        'CheckoutRequestID is required.'
      );
    }

    let merchant;

    try {
      merchant = getStoreAndTill();
    } catch (error) {
      return sendError(res, 500, error.message);
    }

    const {
      storeNumber,
      passkey
    } = merchant;

    const token = await generateToken();
    const timestamp = getTimestamp();

    const password = getPassword(
      storeNumber,
      passkey,
      timestamp
    );

    const payload = {
      BusinessShortCode: storeNumber,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    };

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      }
    );

    console.log('[STK QUERY]', response.data);

    const resultCode = String(
      response.data && response.data.ResultCode
    );

    return res.status(200).json({
      success: resultCode === '0',
      resultCode: response.data.ResultCode,
      resultDesc: response.data.ResultDesc,
      data: response.data
    });
  } catch (error) {
    const mpesaError = getSafaricomError(error);

    console.error(
      '[STK QUERY ERROR]',
      mpesaError || error.message
    );

    return sendError(
      res,
      502,
      getSafaricomMessage(
        mpesaError,
        'Failed to query STK Push status.'
      ),
      mpesaError || undefined
    );
  }
});

/* -------------------------------------------------------------------------- */
/* M-PESA CALLBACK                                                            */
/* -------------------------------------------------------------------------- */

app.post('/api/mpesa/callback', (req, res) => {
  // Acknowledge the callback so Safaricom does not repeatedly retry.
  // This implementation logs callback data but does not persist payments.
  try {
    const callbackData =
      req.body &&
      req.body.Body &&
      req.body.Body.stkCallback;

    if (!callbackData) {
      console.error('[CALLBACK ERROR] Invalid callback format.');

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Accepted'
      });
    }

    console.log(
      '[M-PESA CALLBACK]',
      JSON.stringify(callbackData, null, 2)
    );

    if (Number(callbackData.ResultCode) === 0) {
      const items =
        (callbackData.CallbackMetadata &&
          callbackData.CallbackMetadata.Item) || [];

      const getValue = name => {
        const item = items.find(entry => entry.Name === name);
        return item ? item.Value : undefined;
      };

      console.log('[PAYMENT SUCCESS CALLBACK]', {
        checkoutRequestId: callbackData.CheckoutRequestID,
        merchantRequestId: callbackData.MerchantRequestID,
        receipt: getValue('MpesaReceiptNumber'),
        amount: getValue('Amount'),
        phone: getValue('PhoneNumber'),
        transactionDate: getValue('TransactionDate')
      });
    } else {
      console.log('[PAYMENT FAILED CALLBACK]', {
        checkoutRequestId: callbackData.CheckoutRequestID,
        resultCode: callbackData.ResultCode,
        resultDesc: callbackData.ResultDesc
      });
    }
  } catch (error) {
    console.error('[CALLBACK ERROR]', error.message);
  }

  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: 'Accepted'
  });
});

/* -------------------------------------------------------------------------- */
/* ERROR HANDLING                                                             */
/* -------------------------------------------------------------------------- */

app.use('/api', (req, res) => {
  return sendError(res, 404, 'API endpoint not found.');
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (
    err &&
    (err.type === 'entity.parse.failed' ||
      err instanceof SyntaxError)
  ) {
    return sendError(
      res,
      400,
      'Request body contains invalid JSON. Send a valid JSON object.'
    );
  }

  if (err && err.type === 'entity.too.large') {
    return sendError(
      res,
      413,
      'Request body is too large.'
    );
  }

  console.error(
    '[EXPRESS ERROR]',
    err && err.message ? err.message : err
  );

  return sendError(res, 500, 'Internal server error.');
});

/* -------------------------------------------------------------------------- */
/* START SERVER                                                               */
/* -------------------------------------------------------------------------- */

// Vercel imports this Express app. Run locally with `npm start`.
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);

  app.listen(port, () => {
    console.log(
      `WorkAway International payment server listening on port ${port}`
    );
  });
}

module.exports = app;
