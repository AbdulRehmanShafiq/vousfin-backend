/**
 * End-to-end API smoke test (Postman-equivalent).
 * Run: node scripts/test-all-apis.js
 * Requires server on PORT (default 5000) and MongoDB.
 */
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const config = require('../config');
const User = require('../models/User.model');
const { hashPassword } = require('../utils/password.utils');

const BASE = `http://127.0.0.1:${config.PORT || 5000}`;
const PASSWORD = 'Test@1234';
const ts = Date.now();
const customerEmail = `apitest_${ts}@example.com`;
const adminEmail = `admin_${ts}@example.com`;

const results = [];
let customerToken = null;
let adminToken = null;
let customerId = null;
let accountIds = {};
let transactionId = null;
let customAccountId = null;

const req = async (name, method, path, { body, token, query, isMultipart, expectStatus } = {}) => {
  const url = new URL(path, BASE);
  if (query) {
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let fetchBody = body;
  if (body && !isMultipart) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, { method, headers, body: fetchBody });
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    const ok = expectStatus ? res.status === expectStatus : res.status >= 200 && res.status < 300;
    results.push({ name, ok, status: res.status, message: data?.message || (ok ? 'OK' : String(data).slice(0, 120)) });
    return { res, data, status: res.status };
  } catch (err) {
    results.push({ name, ok: false, status: 0, message: err.message });
    return { res: null, data: null, status: 0, error: err };
  }
};

const buildExcelBuffer = async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Transactions');
  sheet.addRow(['Date', 'Description', 'Amount', 'Type', 'Debit Account', 'Credit Account']);
  sheet.addRow([
    new Date().toISOString().split('T')[0],
    'API test expense',
    500,
    'Expense',
    'Rent Expense',
    'Cash',
  ]);
  return wb.xlsx.writeBuffer();
};

const seedAdmin = async () => {
  await mongoose.connect(config.MONGO_URI);
  const hash = await hashPassword(PASSWORD);
  await User.findOneAndUpdate(
    { email: adminEmail },
    {
      fullName: 'API Test Admin',
      email: adminEmail,
      passwordHash: hash,
      authProvider: 'local',
      role: 'admin',
      status: 'active',
    },
    { upsert: true, new: true }
  );
  await mongoose.disconnect();
};

const main = async () => {
  console.log(`\n🧪 API tests → ${BASE}\n`);

  // --- Health ---
  await req('GET /health', 'GET', '/health');
  await req('GET /api/v1/health', 'GET', '/api/v1/health');

  // --- Auth (public) ---
  await req('POST /auth/register', 'POST', '/api/v1/auth/register', {
    body: { fullName: 'API Test User', email: customerEmail, password: PASSWORD },
  });
  await req('POST /auth/login (pending)', 'POST', '/api/v1/auth/login', {
    body: { email: customerEmail, password: PASSWORD },
    expectStatus: 403,
  });

  await mongoose.connect(config.MONGO_URI);
  const user = await User.findOne({ email: customerEmail });
  customerId = user?._id?.toString();
  const verifyToken = user?.verificationToken;
  await mongoose.disconnect();

  if (verifyToken) {
    await req('POST /auth/verify-email', 'POST', '/api/v1/auth/verify-email', {
      body: { token: verifyToken },
    });
  }

  const login = await req('POST /auth/login', 'POST', '/api/v1/auth/login', {
    body: { email: customerEmail, password: PASSWORD },
  });
  customerToken = login.data?.data?.token || login.data?.token;

  await req('POST /auth/resend-verification', 'POST', '/api/v1/auth/resend-verification', {
    body: { email: customerEmail },
  });
  await req('POST /auth/forgot-password', 'POST', '/api/v1/auth/forgot-password', {
    body: { email: customerEmail },
  });

  // --- Business ---
  await req('POST /business', 'POST', '/api/v1/business', {
    token: customerToken,
    body: {
      businessName: 'API Test Co',
      businessType: 'Freelancer',
      currency: 'PKR',
      fiscalYearStartMonth: 1,
    },
  });
  const biz = await req('GET /business', 'GET', '/api/v1/business', {
    token: customerToken,
    query: { includeAccountCount: 'true' },
  });
  await req('PUT /business', 'PUT', '/api/v1/business', {
    token: customerToken,
    body: { businessName: 'API Test Co Updated' },
  });

  const accounts = await req('GET /business/accounts', 'GET', '/api/v1/business/accounts', {
    token: customerToken,
  });
  const list = accounts.data?.data?.data || accounts.data?.data || [];
  (Array.isArray(list) ? list : []).forEach((a) => {
    if (a.accountName === 'Cash') accountIds.cash = a._id;
    if (a.accountName === 'Rent Expense') accountIds.rent = a._id;
    if (a.accountName === 'Sales Revenue') accountIds.revenue = a._id;
  });

  const newAcc = await req('POST /business/accounts', 'POST', '/api/v1/business/accounts', {
    token: customerToken,
    body: { accountName: 'Test Petty Cash', accountType: 'Asset', normalBalance: 'Debit' },
  });
  customAccountId = newAcc.data?.data?._id;

  if (customAccountId) {
    await req('PUT /business/accounts/:id', 'PUT', `/api/v1/business/accounts/${customAccountId}`, {
      token: customerToken,
      body: { accountName: 'Test Petty Cash Updated' },
    });
  }

  // Re-login to refresh businessId on JWT
  const login2 = await req('POST /auth/login (refresh token)', 'POST', '/api/v1/auth/login', {
    body: { email: customerEmail, password: PASSWORD },
  });
  customerToken = login2.data?.data?.token || login2.data?.token || customerToken;

  const debitId = accountIds.rent;
  const creditId = accountIds.cash;

  // --- Transactions ---
  if (debitId && creditId) {
    const tx = await req('POST /transactions/form', 'POST', '/api/v1/transactions/form', {
      token: customerToken,
      body: {
        transactionDate: new Date().toISOString(),
        description: 'API test rent payment',
        transactionType: 'Expense',
        amount: 1000,
        debitAccountId: debitId,
        creditAccountId: creditId,
      },
    });
    transactionId = tx.data?.data?._id;

    await req('POST /transactions/nl', 'POST', '/api/v1/transactions/nl', {
      token: customerToken,
      body: { text: 'Paid 500 for office supplies from cash' },
    });

    await req('POST /transactions/nl/confirm', 'POST', '/api/v1/transactions/nl/confirm', {
      token: customerToken,
      body: {
        transactionDate: new Date().toISOString(),
        description: 'Office supplies',
        transactionType: 'Expense',
        amount: 500,
        debitAccountId: debitId,
        creditAccountId: creditId,
      },
    });

    const excelBuf = Buffer.from(await buildExcelBuffer());
    const boundary = `----FormBoundary${Date.now()}`;
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
      ),
      excelBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const excelRes = await fetch(`${BASE}/api/v1/transactions/excel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });
    const excelData = await excelRes.json();
    results.push({
      name: 'POST /transactions/excel',
      ok: excelRes.ok,
      status: excelRes.status,
      message: excelData?.message || 'OK',
    });
    const validRows = excelData?.data?.validRows;
    if (validRows?.length) {
      await req('POST /transactions/excel/confirm', 'POST', '/api/v1/transactions/excel/confirm', {
        token: customerToken,
        body: { rows: validRows },
      });
    }

    await req('GET /transactions', 'GET', '/api/v1/transactions', {
      token: customerToken,
      query: { page: '1', limit: '10' },
    });

    if (transactionId) {
      await req('GET /transactions/:id', 'GET', `/api/v1/transactions/${transactionId}`, {
        token: customerToken,
      });
      await req('PUT /transactions/:id', 'PUT', `/api/v1/transactions/${transactionId}`, {
        token: customerToken,
        body: { description: 'API test rent payment updated', amount: 1100 },
      });
    }
  }

  // --- Reports ---
  const startDate = '2025-01-01';
  const endDate = '2025-12-31';
  await req('GET /reports/income-statement', 'GET', '/api/v1/reports/income-statement', {
    token: customerToken,
    query: { startDate, endDate },
  });
  await req('GET /reports/balance-sheet', 'GET', '/api/v1/reports/balance-sheet', {
    token: customerToken,
    query: { asOfDate: endDate },
  });
  await req('GET /reports/cash-flow', 'GET', '/api/v1/reports/cash-flow', {
    token: customerToken,
    query: { startDate, endDate },
  });
  await req('GET /reports/kpi', 'GET', '/api/v1/reports/kpi', {
    token: customerToken,
    query: { startDate, endDate },
  });
  await req('GET /reports/export (pdf)', 'GET', '/api/v1/reports/export', {
    token: customerToken,
    query: { type: 'incomeStatement', format: 'pdf', startDate, endDate },
  });
  await req('GET /reports/export (xlsx)', 'GET', '/api/v1/reports/export', {
    token: customerToken,
    query: { type: 'incomeStatement', format: 'xlsx', startDate, endDate },
  });

  // --- Dashboard ---
  await req('GET /dashboard/kpis', 'GET', '/api/v1/dashboard/kpis', { token: customerToken });
  await req('GET /dashboard/revenue-vs-expenses', 'GET', '/api/v1/dashboard/revenue-vs-expenses', {
    token: customerToken,
  });
  await req('GET /dashboard/cash-flow-trend', 'GET', '/api/v1/dashboard/cash-flow-trend', {
    token: customerToken,
  });
  await req('GET /dashboard/all', 'GET', '/api/v1/dashboard/all', { token: customerToken });

  // --- AI ---
  await req('POST /ai/parse-nl', 'POST', '/api/v1/ai/parse-nl', {
    token: customerToken,
    body: { text: 'Received 2000 from client for consulting' },
  });
  await req('POST /ai/rag-query', 'POST', '/api/v1/ai/rag-query', {
    token: customerToken,
    body: { question: 'What is my total revenue?' },
  });
  await req('POST /ai/cashflow-recommendations', 'POST', '/api/v1/ai/cashflow-recommendations', {
    token: customerToken,
    body: {},
  });
  await req('POST /ai/forecast', 'POST', '/api/v1/ai/forecast', {
    token: customerToken,
    body: { metric: 'revenue', horizon: 3 },
  });
  await req('POST /ai/anomaly-scan', 'POST', '/api/v1/ai/anomaly-scan', {
    token: customerToken,
    body: {},
  });
  await req('POST /ai/semantic-search', 'POST', '/api/v1/ai/semantic-search', {
    token: customerToken,
    body: { query: 'rent' },
  });

  // --- Admin ---
  await seedAdmin();
  const adminLogin = await req('POST /admin login', 'POST', '/api/v1/auth/login', {
    body: { email: adminEmail, password: PASSWORD },
  });
  adminToken = adminLogin.data?.data?.token || adminLogin.data?.token;

  await req('GET /admin/stats', 'GET', '/api/v1/admin/stats', { token: adminToken });
  const customers = await req('GET /admin/customers', 'GET', '/api/v1/admin/customers', {
    token: adminToken,
  });
  const custId = customerId || customers.data?.data?.[0]?._id;
  if (custId) {
    await req('GET /admin/customers/:id', 'GET', `/api/v1/admin/customers/${custId}`, {
      token: adminToken,
    });
    await req('PUT /admin/customers/:id/suspend', 'PUT', `/api/v1/admin/customers/${custId}/suspend`, {
      token: adminToken,
      body: { reason: 'API test' },
    });
    await req('PUT /admin/customers/:id/reinstate', 'PUT', `/api/v1/admin/customers/${custId}/reinstate`, {
      token: adminToken,
    });
  }

  // --- Cleanup ---
  if (transactionId) {
    await req('DELETE /transactions/:id', 'DELETE', `/api/v1/transactions/${transactionId}`, {
      token: customerToken,
    });
  }
  await req('POST /auth/logout', 'POST', '/api/v1/auth/logout', { token: customerToken });

  // --- Summary ---
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n--- Results ---');
  results.forEach((r) => {
    const icon = r.ok ? '✅' : '❌';
    console.log(`${icon} [${r.status}] ${r.name}: ${r.message}`);
  });
  console.log(`\n${passed}/${results.length} passed, ${failed.length} failed\n`);
  if (failed.length) process.exit(1);
};

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
