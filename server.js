const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = process.env.MPESA_ENV || 'sandbox';

// Base URL routing
const BASE_URL = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Fixed Amount Enforcement (KSH 35,000)
const FIXED_AMOUNT = 35000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware: OAuth2 Token Generation
const generateToken = async (req, res, next) => {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  try {
    const response = await axios.get(
      `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    req.token = response.data.access_token;
    next();
  } catch (error) {
    console.error('[TOKEN GENERATION ERROR]:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate OAuth token. Check Consumer Key and Secret.'
    });
  }
};

// Helper: Safaricom Timestamp (YYYYMMDDHHmmss)
const getTimestamp = () => {
  const date = new Date();
  return (
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0')
  );
};

// Helper: Base64 Password = Base64(ShortCode + Passkey + Timestamp)
const getPassword = (shortCode, passkey, timestamp) => {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
};

/**
 * Route: Trigger STK Push Prompt for Fixed $ 35,000
 * Sandbox Endpoint: https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest
 */
app.post('/api/stkpush', generateToken, async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      success: false,
      message: 'Phone number is required.'
    });
  }

  // Format phone number to 254XXXXXXXXX
  let formattedPhone = phoneNumber.toString().trim().replace(/\+/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = `254${formattedPhone.substring(1)}`;
  }

  const shortCode = process.env.MPESA_SHORTCODE || '174379';
  const passkey = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const timestamp = getTimestamp();
  const password = getPassword(shortCode, passkey, timestamp);

  const payload = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: FIXED_AMOUNT,
    PartyA: formattedPhone,
    PartyB: shortCode,
    PhoneNumber: formattedPhone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: 'SandboxTest35K',
    TransactionDesc: 'Test Payment of $ 35000'
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${req.token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: `STK push prompt sent to ${formattedPhone}. Enter your M-Pesa PIN on your phone.`,
      checkoutRequestId: response.data.CheckoutRequestID,
      merchantRequestId: response.data.MerchantRequestID
    });
  } catch (error) {
    const mpesaError = error.response?.data;
    console.error('[STK PUSH ERROR]:', mpesaError || error.message);

    return res.status(500).json({
      success: false,
      message: mpesaError?.errorMessage || mpesaError?.responseDescription || 'Failed to trigger STK Push.',
      details: mpesaError
    });
  }
});

/**
 * Route: Query STK Push Status
 * Sandbox Endpoint: https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query
 */
app.post('/api/stkpush/query', generateToken, async (req, res) => {
  const { checkoutRequestId } = req.body;

  if (!checkoutRequestId) {
    return res.status(400).json({ success: false, message: 'CheckoutRequestID required.' });
  }

  const shortCode = process.env.MPESA_SHORTCODE || '174379';
  const passkey = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const timestamp = getTimestamp();
  const password = getPassword(shortCode, passkey, timestamp);

  const payload = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${req.token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.status(200).json({
      success: response.data.ResultCode === '0',
      resultCode: response.data.ResultCode,
      resultDesc: response.data.ResultDesc,
      data: response.data
    });
  } catch (error) {
    console.error('[STK QUERY ERROR]:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.errorMessage || 'Failed to query STK Push status.'
    });
  }
});

/**
 * Route: Callback Webhook Receiver
 */
app.post('/api/mpesa/callback', (req, res) => {
  const callbackData = req.body.Body?.stkCallback;

  if (!callbackData) {
    return res.status(400).send('Invalid callback format');
  }

  const resultCode = callbackData.ResultCode;
  const resultDesc = callbackData.ResultDesc;

  if (resultCode === 0) {
    const metadata = callbackData.CallbackMetadata?.Item || [];
    const amount = metadata.find(i => i.Name === 'Amount')?.Value;
    const receipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
    const phone = metadata.find(i => i.Name === 'PhoneNumber')?.Value;

    console.log(`[SUCCESS] Receipt: ${receipt} | $ ${amount} | Phone: ${phone}`);
  } else {
    console.log(`[FAILED] Code: ${resultCode} - ${resultDesc}`);
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.listen(PORT, () => {
  console.log(`[${ENV.toUpperCase()}] Sandbox STK Server running at http://localhost:${PORT}`);
});