/**
 * taxFilingCalendar.js — FR-04.1
 *
 * Per-country filing obligations. Each rule yields the next due date for a tax
 * type via utils/nextDeadline. Frequencies: 'monthly' (dueDay) or 'annual'
 * (dueMonth 1-12 + dueDay). Pure data — no DB.
 */
'use strict';

const CALENDARS = {
  PK: [
    { taxType: 'GST',        label: 'Sales Tax Return (GST-01)', frequency: 'monthly', dueDay: 18,              returnType: 'GST-01'    },
    { taxType: 'WHT',        label: 'WHT Statement (165)',       frequency: 'monthly', dueDay: 15,              returnType: 'WHT-165'   },
    { taxType: 'INCOME_TAX', label: 'Income Tax Return',         frequency: 'annual',  dueMonth: 9, dueDay: 30, returnType: 'IT-RETURN' },
    { taxType: 'EOBI',       label: 'EOBI Contribution',         frequency: 'monthly', dueDay: 15,              returnType: 'EOBI'      },
    { taxType: 'SESSI',      label: 'SESSI Contribution',        frequency: 'monthly', dueDay: 15,              returnType: 'SESSI'     },
  ],
};

/** Filing rules for a country (defaults to PK). */
function getCalendar(country = 'PK') {
  return CALENDARS[country] || CALENDARS.PK;
}

module.exports = { CALENDARS, getCalendar };
