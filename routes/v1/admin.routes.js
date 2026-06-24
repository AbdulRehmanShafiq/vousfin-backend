const express = require('express');
const router = express.Router();
const adminController = require('../../controllers/admin.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const adminMiddleware = require('../../middleware/admin.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  listCustomersQuerySchema,
  listBusinessesQuerySchema,
  customerIdParamSchema,
  suspendCustomerBodySchema,
  changeRoleBodySchema,
} = require('../../validations/admin.validation');
const { updateStatusSchema } = require('../../validations/feedback.validation');
const { replySchema, updateTicketSchema } = require('../../validations/support.validation');
const { createSchema: createAnnouncementSchema, updateSchema: updateAnnouncementSchema } = require('../../validations/announcement.validation');

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware);

// Stats
router.get('/stats', adminController.getSystemStats);

// Customer management
router.get('/customers', validate(listCustomersQuerySchema, 'query'), adminController.getAllCustomers);
router.get('/customers/:id', validate(customerIdParamSchema, 'params'), adminController.getCustomerById);
router.put('/customers/:id/suspend', validate(customerIdParamSchema, 'params'), validate(suspendCustomerBodySchema), adminController.suspendCustomer);
router.put('/customers/:id/reinstate', validate(customerIdParamSchema, 'params'), adminController.reinstateCustomer);
router.put('/customers/:id/verify', validate(customerIdParamSchema, 'params'), adminController.verifyCustomer);
router.put('/customers/:id/role', validate(customerIdParamSchema, 'params'), validate(changeRoleBodySchema), adminController.changeRole);
router.delete('/customers/:id', validate(customerIdParamSchema, 'params'), adminController.deleteCustomer);

// Business listing
router.get('/businesses', validate(listBusinessesQuerySchema, 'query'), adminController.getAllBusinesses);

// ─── Feedback ──────────────────────────────────────────────────────────────────
router.get('/feedback',         adminController.listFeedback);
router.patch('/feedback/:id',   validate(updateStatusSchema), adminController.updateFeedbackStatus);

// ─── Support tickets ───────────────────────────────────────────────────────────
router.get('/support',              adminController.listSupportTickets);
router.get('/support/:id',          adminController.getSupportTicket);
router.post('/support/:id/reply',   validate(replySchema), adminController.addAdminTicketReply);
router.patch('/support/:id',        validate(updateTicketSchema), adminController.updateSupportTicket);

// ─── Announcements ─────────────────────────────────────────────────────────────
router.get('/announcements',        adminController.listAnnouncements);
router.post('/announcements',       validate(createAnnouncementSchema), adminController.createAnnouncement);
router.patch('/announcements/:id',  validate(updateAnnouncementSchema), adminController.updateAnnouncement);
router.delete('/announcements/:id', adminController.removeAnnouncement);

// ─── Platform activity log ─────────────────────────────────────────────────────
router.get('/activity', adminController.getRecentActivity);

// ─── Reset MFA ─────────────────────────────────────────────────────────────────
router.put('/customers/:id/reset-mfa', validate(customerIdParamSchema, 'params'), adminController.resetUserMfa);

module.exports = router;
