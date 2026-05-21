/**
 * Seeds Code Hub (software house) + ~3 months of transactions for demo user.
 * Usage: node scripts/seedCodeHubDemo.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const config = require('../config');

const EMAIL = 'muhammaduzair4114@gmail.com';
const PASSWORD = 'Uzair123@';
const BUSINESS_NAME = 'Code Hub';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function monthDate(year, month, day) {
  return new Date(year, month - 1, day).toISOString();
}

const TRANSACTIONS = [
  { date: monthDate(2026, 2, 5), type: 'Income', amount: 450000, desc: 'Web app delivery — FinTech client', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 2, 8), type: 'Expense', amount: 85000, desc: 'February developer salaries', debit: 'Salaries Expense', credit: 'Bank' },
  { date: monthDate(2026, 2, 10), type: 'Expense', amount: 12000, desc: 'AWS cloud hosting', debit: 'Utilities Expense', credit: 'Bank' },
  { date: monthDate(2026, 2, 12), type: 'Expense', amount: 35000, desc: 'Office rent February', debit: 'Rent Expense', credit: 'Bank' },
  { date: monthDate(2026, 2, 18), type: 'Income', amount: 180000, desc: 'Milestone payment — ERP module', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 2, 22), type: 'Expense', amount: 15000, desc: 'Digital marketing campaigns', debit: 'Marketing Expense', credit: 'Cash' },
  { date: monthDate(2026, 2, 25), type: 'Expense', amount: 8000, desc: 'Internet and utilities', debit: 'Utilities Expense', credit: 'Cash' },
  { date: monthDate(2026, 3, 3), type: 'Income', amount: 320000, desc: 'Mobile app phase 2 — retail client', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 3, 7), type: 'Expense', amount: 92000, desc: 'March payroll', debit: 'Salaries Expense', credit: 'Bank' },
  { date: monthDate(2026, 3, 9), type: 'Expense', amount: 14000, desc: 'AWS + GitHub enterprise', debit: 'Utilities Expense', credit: 'Bank' },
  { date: monthDate(2026, 3, 11), type: 'Expense', amount: 35000, desc: 'Office rent March', debit: 'Rent Expense', credit: 'Bank' },
  { date: monthDate(2026, 3, 15), type: 'Income', amount: 95000, desc: 'Support retainer — logistics SaaS', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 3, 20), type: 'Expense', amount: 22000, desc: 'UI/UX contractor invoice', debit: 'Miscellaneous Expense', credit: 'Bank' },
  { date: monthDate(2026, 3, 24), type: 'Income', amount: 210000, desc: 'API integration project closing', debit: 'Accounts Receivable', credit: 'Service Revenue' },
  { date: monthDate(2026, 3, 28), type: 'Income', amount: 210000, desc: 'AR collection — API integration', debit: 'Bank', credit: 'Accounts Receivable' },
  { date: monthDate(2026, 4, 2), type: 'Expense', amount: 45000, desc: 'New laptops for dev team', debit: 'Fixed Assets', credit: 'Bank' },
  { date: monthDate(2026, 4, 5), type: 'Income', amount: 520000, desc: 'Enterprise dashboard — insurance client', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 4, 8), type: 'Expense', amount: 98000, desc: 'April salaries', debit: 'Salaries Expense', credit: 'Bank' },
  { date: monthDate(2026, 4, 10), type: 'Expense', amount: 35000, desc: 'Office rent April', debit: 'Rent Expense', credit: 'Bank' },
  { date: monthDate(2026, 4, 12), type: 'Expense', amount: 16000, desc: 'Cloud + monitoring tools', debit: 'Utilities Expense', credit: 'Bank' },
  { date: monthDate(2026, 4, 16), type: 'Expense', amount: 18000, desc: 'Conference sponsorship', debit: 'Marketing Expense', credit: 'Bank' },
  { date: monthDate(2026, 4, 20), type: 'Income', amount: 125000, desc: 'Maintenance contract Q2', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 4, 25), type: 'Transfer', amount: 50000, desc: 'Transfer cash to bank for payroll float', debit: 'Bank', credit: 'Cash' },
  { date: monthDate(2026, 5, 2), type: 'Income', amount: 380000, desc: 'AI chatbot delivery — healthcare client', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 5, 5), type: 'Expense', amount: 105000, desc: 'May payroll', debit: 'Salaries Expense', credit: 'Bank' },
  { date: monthDate(2026, 5, 7), type: 'Expense', amount: 35000, desc: 'Office rent May', debit: 'Rent Expense', credit: 'Bank' },
  { date: monthDate(2026, 5, 9), type: 'Expense', amount: 11000, desc: 'Electricity and internet', debit: 'Utilities Expense', credit: 'Cash' },
  { date: monthDate(2026, 5, 12), type: 'Income', amount: 165000, desc: 'Sprint billing — e-commerce client', debit: 'Bank', credit: 'Service Revenue' },
  { date: monthDate(2026, 5, 15), type: 'Expense', amount: 28000, desc: 'QA outsourcing', debit: 'Miscellaneous Expense', credit: 'Bank' },
  { date: monthDate(2026, 5, 18), type: 'Income', amount: 75000, desc: 'License resale commission', debit: 'Cash', credit: 'Other Income' },
  { date: monthDate(2026, 5, 20), type: 'Expense', amount: 12000, desc: 'Team lunch and client meeting', debit: 'Miscellaneous Expense', credit: 'Cash' },
];

async function api(base, path, method, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.errors || res.statusText);
  }
  return data;
}

async function main() {
  const base = `http://localhost:${config.PORT || 5000}/api/v1`;
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(config.MONGO_URI);
  console.log('✅ MongoDB connected');

  console.log(`🔐 Logging in as ${EMAIL}...`);
  const login = await api(base, '/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
  const token = login.data.token;
  const userId = login.data.user._id || login.data.user.id;
  console.log('✅ Logged in');

  let business = null;
  try {
    const bizRes = await api(base, '/business', 'GET', null, token);
    business = bizRes.data;
    console.log(`ℹ️ Existing business: ${business.businessName}`);
  } catch {
    business = null;
  }

  if (!business) {
    console.log('🏢 Creating Code Hub business...');
    const created = await api(base, '/business', 'POST', {
      businessName: BUSINESS_NAME,
      businessType: 'Private Limited',
      currency: 'PKR',
      fiscalYearStartMonth: 7,
    }, token);
    business = created.data;
    console.log('✅ Business created');
  } else if (business.businessName !== BUSINESS_NAME) {
    await api(base, '/business', 'PUT', { businessName: BUSINESS_NAME, businessType: 'Private Limited' }, token);
    console.log('✅ Business renamed to Code Hub');
  }

  const accountsRes = await api(base, '/business/accounts?limit=100', 'GET', null, token);
  const accounts = accountsRes.data?.data || accountsRes.data || [];
  const byName = {};
  (Array.isArray(accounts) ? accounts : []).forEach((a) => {
    byName[a.accountName] = a._id || a.id;
  });

  const resolve = (name) => {
    const id = byName[name];
    if (!id) throw new Error(`Account not found: ${name}`);
    return id;
  };

  console.log(`📒 ${Object.keys(byName).length} accounts loaded`);
  console.log('💸 Seeding transactions...');

  let created = 0;
  let skipped = 0;

  for (const tx of TRANSACTIONS) {
    try {
      await api(base, '/transactions/form', 'POST', {
        transactionDate: tx.date,
        description: tx.desc,
        transactionType: tx.type,
        amount: tx.amount,
        debitAccountId: resolve(tx.debit),
        creditAccountId: resolve(tx.credit),
      }, token);
      created++;
    } catch (err) {
      if (String(err.message).includes('duplicate') || String(err.message).includes('already')) {
        skipped++;
      } else {
        console.warn(`⚠️ Skip: ${tx.desc} — ${err.message}`);
        skipped++;
      }
    }
  }

  console.log(`\n✅ Done: ${created} transactions created, ${skipped} skipped`);
  console.log(`👤 User: ${EMAIL}`);
  console.log(`🏢 Business: ${BUSINESS_NAME}`);
  console.log('🌐 Open http://localhost:5173/login and sign in\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
