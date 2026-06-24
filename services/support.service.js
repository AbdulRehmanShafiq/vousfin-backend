'use strict';
const SupportTicket = require('../models/SupportTicket.model');
const { ApiError } = require('../utils/ApiError');

class SupportService {
  /** Create ticket with first user message. */
  async createTicket(actor, { subject, category, priority, message }) {
    return SupportTicket.create({
      userId:         actor.id,
      businessId:     actor.businessId || null,
      requesterName:  actor.fullName  || '',
      requesterEmail: actor.email     || '',
      subject,
      category,
      priority,
      messages: [{ from: 'user', authorId: actor.id, body: message }],
    });
  }

  /** List tickets owned by a user, newest-updated first. */
  async listMyTickets(userId) {
    return SupportTicket.find({ userId }).sort({ updatedAt: -1 }).lean();
  }

  /** Get a single ticket — 404 if not owned by userId. */
  async getTicket(id, userId) {
    const ticket = await SupportTicket.findById(id).lean();
    if (!ticket) throw new ApiError(404, 'Ticket not found');
    if (String(ticket.userId) !== String(userId)) throw new ApiError(403, 'Access denied');
    return ticket;
  }

  /** Admin: get any ticket. */
  async getTicketAdmin(id) {
    const ticket = await SupportTicket.findById(id).populate('userId', 'email fullName').lean();
    if (!ticket) throw new ApiError(404, 'Ticket not found');
    return ticket;
  }

  /** User reply — reopens resolved/closed tickets. */
  async addUserReply(id, userId, body) {
    const ticket = await SupportTicket.findById(id);
    if (!ticket) throw new ApiError(404, 'Ticket not found');
    if (String(ticket.userId) !== String(userId)) throw new ApiError(403, 'Access denied');
    ticket.messages.push({ from: 'user', authorId: userId, body });
    if (['resolved', 'closed'].includes(ticket.status)) ticket.status = 'open';
    return ticket.save();
  }

  /** Admin: list all tickets, paginated. */
  async listAll({ status, priority, page = 1, limit = 50 } = {}) {
    const query = {};
    if (status)   query.status   = status;
    if (priority) query.priority = priority;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      SupportTicket.find(query)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('userId', 'email fullName')
        .lean(),
      SupportTicket.countDocuments(query),
    ]);
    return { data, total, page: Number(page), limit: Number(limit) };
  }

  /** Admin reply — moves open tickets to in_progress. */
  async addAdminReply(id, adminId, body) {
    const ticket = await SupportTicket.findById(id);
    if (!ticket) throw new ApiError(404, 'Ticket not found');
    ticket.messages.push({ from: 'admin', authorId: adminId, body });
    if (ticket.status === 'open') ticket.status = 'in_progress';
    return ticket.save();
  }

  /** Admin: update status/priority on a ticket. */
  async updateTicket(id, { status, priority } = {}) {
    const update = {};
    if (status   !== undefined) update.status   = status;
    if (priority !== undefined) update.priority = priority;
    const ticket = await SupportTicket.findByIdAndUpdate(id, update, { new: true });
    if (!ticket) throw new ApiError(404, 'Ticket not found');
    return ticket;
  }
}

module.exports = new SupportService();
