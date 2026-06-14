'use strict';

const { nextDeadline } = require('../../../utils/nextDeadline');

const GST = { frequency: 'monthly', dueDay: 18 };
const IT  = { frequency: 'annual', dueMonth: 9, dueDay: 30 };

describe('nextDeadline', () => {
  it('monthly: due later this month', () => {
    const { dueDate, daysRemaining } = nextDeadline(GST, new Date(2026, 5, 10));
    expect(dueDate.getMonth()).toBe(5); // June
    expect(dueDate.getDate()).toBe(18);
    expect(daysRemaining).toBe(8);
  });

  it('monthly: rolls to next month once the due day has passed', () => {
    const { dueDate } = nextDeadline(GST, new Date(2026, 5, 20));
    expect(dueDate.getMonth()).toBe(6); // July
    expect(dueDate.getDate()).toBe(18);
  });

  it('monthly: due today is zero days remaining', () => {
    const { daysRemaining } = nextDeadline(GST, new Date(2026, 5, 18));
    expect(daysRemaining).toBe(0);
  });

  it('annual: this year when the date has not passed', () => {
    const { dueDate } = nextDeadline(IT, new Date(2026, 5, 10));
    expect(dueDate.getFullYear()).toBe(2026);
    expect(dueDate.getMonth()).toBe(8); // September (0-indexed)
    expect(dueDate.getDate()).toBe(30);
  });

  it('annual: next year once the date has passed', () => {
    const { dueDate } = nextDeadline(IT, new Date(2026, 10, 1));
    expect(dueDate.getFullYear()).toBe(2027);
  });
});
