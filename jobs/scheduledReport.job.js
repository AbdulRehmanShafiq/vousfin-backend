'use strict';

const cron = require('node-cron');
const reportTemplateRepo = require('../repositories/reportTemplate.repository');
const reportBuilder = require('../services/reportBuilder.service');
const businessRepository = require('../repositories/business.repository');
const pdfExport = require('../utils/pdfExport.utils');
const { sendEmail } = require('../utils/email.utils');
const logger = require('../config/logger');

/** Pure: next run instant given a schedule and a reference time (UTC). */
function computeNextRun(schedule, fromDate) {
  const from = new Date(fromDate);
  const hour = Number.isInteger(schedule.hour) ? schedule.hour : 6;
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, 0, 0, 0));
  if (schedule.frequency === 'daily') {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (schedule.frequency === 'weekly') {
    const target = Number.isInteger(schedule.dayOfWeek) ? schedule.dayOfWeek : 1;
    let delta = (target - next.getUTCDay() + 7) % 7;
    if (delta === 0 && next <= from) delta = 7;
    next.setUTCDate(next.getUTCDate() + delta);
    return next;
  }
  // monthly
  const dom = Number.isInteger(schedule.dayOfMonth) ? schedule.dayOfMonth : 1;
  next.setUTCDate(dom);
  if (next <= from) next.setUTCMonth(next.getUTCMonth() + 1, dom);
  return next;
}

/** Render + email every template whose schedule is due. One failure never aborts the sweep. */
async function runDueReports(now = new Date()) {
  const due = await reportTemplateRepo.findScheduledDue(now);
  let sent = 0;
  for (const tpl of due) {
    try {
      const recipients = (tpl.schedule.recipients || []).filter(Boolean);
      if (recipients.length === 0) continue;

      const business = await businessRepository.findById(tpl.businessId);
      const endDate = new Date(now);
      const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
      const data = await reportBuilder.renderTemplate(tpl.businessId, tpl._id, { startDate, endDate });

      const pdf = await pdfExport.generateReportBuilderPDF({
        businessName: business?.businessName || 'My Business',
        currency: business?.currency || 'PKR',
        data,
        title: tpl.name,
      });

      await sendEmail({
        to: recipients.join(','),
        subject: `${tpl.name} — ${business?.businessName || 'your business'}`,
        html: `<p>Your scheduled report "<strong>${tpl.name}</strong>" is attached as a PDF.</p>`,
        attachments: [{ filename: `${tpl.name.replace(/[^\w-]+/g, '_')}.pdf`, content: pdf }],
      });

      await reportTemplateRepo.update(tpl._id, {
        'schedule.lastRunAt': now,
        'schedule.nextRunAt': computeNextRun(tpl.schedule, now),
      });
      sent++;
    } catch (err) {
      logger.error(`[scheduledReport] template ${tpl._id} failed: ${err.message}`);
    }
  }
  return { due: due.length, sent };
}

/** Register the hourly cron. */
function scheduleReportDelivery() {
  cron.schedule('5 * * * *', async () => {
    try {
      const r = await runDueReports(new Date());
      if (r.sent) logger.info(`[cron] scheduledReport: sent ${r.sent}/${r.due}`);
    } catch (err) {
      logger.error(`[cron] scheduledReport error: ${err.message}`);
    }
  });
  logger.info('[cron] scheduledReport delivery registered (hourly)');
}

module.exports = { computeNextRun, runDueReports, scheduleReportDelivery };
