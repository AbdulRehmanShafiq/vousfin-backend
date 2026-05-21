// services/transaction.service.js
const transactionRepository = require('../repositories/transaction.repository');
const accountRepository = require('../repositories/account.repository');
const customerRepository = require('../repositories/customer.repository');
const vendorRepository = require('../repositories/vendor.repository');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const { ENTITY_TYPES, TRANSACTION_TYPES, INPUT_METHODS, JOURNAL_STATUS, PAYMENT_STATUS, TRANSACTION_MODES } = require('../config/constants');
const logger = require('../config/logger');

class TransactionService {
  /**
   * Create a single journal entry (v2).
   * Supports standard entries, AR/AP (Credit Sales/Purchases), and multi-line journals.
   */
  async createTransaction(data, userId, ipAddress) {
    // 1. Core Validation
    if (!data.businessId || !data.transactionDate || !data.amount || !data.debitAccountId || !data.creditAccountId) {
      throw new ApiError(400, 'Missing required transaction fields');
    }
    if (data.amount <= 0) {
      throw new ApiError(400, 'Amount must be greater than zero');
    }
    if (data.debitAccountId.toString() === data.creditAccountId.toString()) {
      throw new ApiError(400, 'Debit and credit accounts must be different');
    }

    // 2. Validate accounts belong to the business
    const debitAccount = await accountRepository.findOneByBusinessAndId(data.businessId, data.debitAccountId);
    const creditAccount = await accountRepository.findOneByBusinessAndId(data.businessId, data.creditAccountId);
    if (!debitAccount || !creditAccount) {
      throw new ApiError(400, 'Invalid account(s) for this business');
    }

    // 3. Auto-infer transactionType when not supplied by frontend
    if (!data.transactionType) {
      const dn = debitAccount.accountName;
      const cn = creditAccount.accountName;
      const dt = debitAccount.accountType;
      const ct = creditAccount.accountType;
      if (ct === 'Revenue') {
        data.transactionType = TRANSACTION_TYPES.INCOME;
      } else if (dt === 'Expense') {
        data.transactionType = TRANSACTION_TYPES.EXPENSE;
      } else if (dn.toLowerCase().includes('receivable') || cn.toLowerCase().includes('receivable')) {
        data.transactionType = TRANSACTION_TYPES.CREDIT_SALE;
      } else if (cn.toLowerCase().includes('payable') || dn.toLowerCase().includes('payable')) {
        data.transactionType = TRANSACTION_TYPES.CREDIT_PURCHASE;
      } else if (dt === 'Asset' && ct === 'Asset') {
        data.transactionType = TRANSACTION_TYPES.TRANSFER;
      } else if (dt === 'Asset' && (ct === 'Liability' || ct === 'Equity')) {
        data.transactionType = TRANSACTION_TYPES.OWNER_INVESTMENT;
      } else if (ct === 'Asset' && (dt === 'Liability' || dt === 'Equity')) {
        data.transactionType = TRANSACTION_TYPES.OWNER_WITHDRAWAL;
      } else {
        data.transactionType = TRANSACTION_TYPES.TRANSFER;
      }
      logger.info(`Auto-inferred transactionType: ${data.transactionType} (debit: ${dn}/${dt}, credit: ${cn}/${ct})`);
    }

    // 4. Resolve customerName / vendorName → IDs (find or auto-create)
    if (!data.customerId && data.customerName?.trim()) {
      const customer = await customerRepository.findOrCreateByName(data.businessId, data.customerName.trim());
      data.customerId = customer._id;
    }
    if (!data.vendorId && data.vendorName?.trim()) {
      const vendor = await vendorRepository.findOrCreateByName(data.businessId, data.vendorName.trim());
      data.vendorId = vendor._id;
    }

    // 5. Setup v2 entry data
    const entryData = {
      ...data,
      status: JOURNAL_STATUS.POSTED,
      createdBy: userId,
      lastModifiedBy: userId,
    };

    // 6. Handle AR (Credit Sale) Workflow — customer optional
    if (data.transactionType === TRANSACTION_TYPES.CREDIT_SALE) {
      entryData.paymentStatus = PAYMENT_STATUS.UNPAID;
      entryData.remainingBalance = data.amount;
      entryData.transactionMode = TRANSACTION_MODES.CREDIT;
      if (data.customerId) {
        const customer = await customerRepository.findByBusinessAndId(data.businessId, data.customerId);
        if (customer) await customerRepository.updateReceivableBalance(data.customerId, data.amount);
      }
    }

    // 7. Handle AP (Credit Purchase) Workflow — vendor optional
    if (data.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE) {
      entryData.paymentStatus = PAYMENT_STATUS.UNPAID;
      entryData.remainingBalance = data.amount;
      entryData.transactionMode = TRANSACTION_MODES.CREDIT;
      if (data.vendorId) {
        const vendor = await vendorRepository.findByBusinessAndId(data.businessId, data.vendorId);
        if (vendor) await vendorRepository.updatePayableBalance(data.vendorId, data.amount);
      }
    }

    // 7. Multi-line journal handling (Future-proofing)
    if (data.journalLines && data.journalLines.length > 0) {
      // Validate sum(debits) = sum(credits)
      let debits = 0, credits = 0;
      for (const line of data.journalLines) {
        if (line.type === 'debit') debits += line.amount;
        if (line.type === 'credit') credits += line.amount;
      }
      if (Math.round(debits * 100) !== Math.round(credits * 100)) {
        throw new ApiError(400, 'Journal lines are unbalanced');
      }
    }

    // 8. Create the entry
    const transaction = await transactionRepository.createTransaction(entryData);

    // 9. Update running account balances
    if (data.journalLines && data.journalLines.length > 0) {
      // Multi-line mode: update each line
      for (const line of data.journalLines) {
        await this._updateAccountBalance(line.accountId, line.amount, line.type);
      }
    } else {
      // Standard 1:1 mode
      await this._updateAccountBalance(data.debitAccountId, data.amount, 'debit');
      await this._updateAccountBalance(data.creditAccountId, data.amount, 'credit');
    }

    // 10. Audit log
    await auditService.logCreate(
      ENTITY_TYPES.JOURNAL_ENTRY,
      transaction._id,
      data.businessId,
      userId,
      transaction.toObject(),
      ipAddress
    );

    logger.info(`Transaction created: ${transaction._id} by user ${userId}`);
    return transaction;
  }

  /**
   * Record a partial or full payment against a parent transaction (Settlement Engine).
   */
  async recordPartialPayment(parentTransactionId, businessId, paymentData, userId, ipAddress) {
    // 1. Validate Parent
    const parent = await transactionRepository.findByIdWithDetails(parentTransactionId, businessId);
    if (!parent) throw new ApiError(404, 'Parent transaction not found');
    if (parent.status === JOURNAL_STATUS.REVERSED) throw new ApiError(400, 'Cannot pay a reversed transaction');
    const hasOutstanding = typeof parent.hasOutstandingBalance === 'function'
      ? parent.hasOutstandingBalance()
      : (parent.remainingBalance !== null && parent.remainingBalance > 0);
    if (!hasOutstanding) throw new ApiError(400, 'Transaction is already fully paid');
    
    // 2. Validate Payment Amount
    if (paymentData.amount <= 0) throw new ApiError(400, 'Payment amount must be greater than zero');
    if (paymentData.amount > parent.remainingBalance) {
      throw new ApiError(400, `Payment amount (${paymentData.amount}) cannot exceed remaining balance (${parent.remainingBalance})`);
    }

    // 3. Determine transaction type based on parent
    let isReceivable = false;
    let paymentDebitAccount, paymentCreditAccount;

    if (parent.transactionType === TRANSACTION_TYPES.CREDIT_SALE) {
      isReceivable = true;
      // DR Cash/Bank (Payment Account)
      paymentDebitAccount = paymentData.paymentAccountId; 
      // CR Accounts Receivable (Parent's Debit Account)
      paymentCreditAccount = parent.debitAccountId._id; 
    } else if (parent.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE) {
      isReceivable = false;
      // DR Accounts Payable (Parent's Credit Account)
      paymentDebitAccount = parent.creditAccountId._id;
      // CR Cash/Bank (Payment Account)
      paymentCreditAccount = paymentData.paymentAccountId;
    } else {
      throw new ApiError(400, 'Parent transaction must be a Credit Sale or Credit Purchase');
    }

    // 4. Create the payment transaction (Child)
    const childData = {
      businessId,
      transactionDate: paymentData.transactionDate || new Date(),
      description: paymentData.description || `Payment for ${parent.transactionReference || 'Transaction'}`,
      transactionType: isReceivable ? TRANSACTION_TYPES.PAYMENT_RECEIVED : TRANSACTION_TYPES.PAYMENT_MADE,
      transactionMode: TRANSACTION_MODES.PARTIAL_SETTLEMENT,
      amount: paymentData.amount,
      debitAccountId: paymentDebitAccount,
      creditAccountId: paymentCreditAccount,
      parentTransactionId: parent._id,
      inputMethod: INPUT_METHODS.FORM,
      transactionReference: paymentData.reference || null,
      customerId: parent.customerId ? parent.customerId._id : null,
      vendorId: parent.vendorId ? parent.vendorId._id : null,
    };

    const childTx = await this.createTransaction(childData, userId, ipAddress);

    // 5. Update Parent
    const newRemainingBalance = parent.remainingBalance - paymentData.amount;
    const newPartiallyPaidAmount = (parent.partiallyPaidAmount || 0) + paymentData.amount;
    let newPaymentStatus = PAYMENT_STATUS.PARTIALLY_PAID;
    
    if (newRemainingBalance === 0) {
      newPaymentStatus = PAYMENT_STATUS.PAID;
    } else if (parent.dueDate && new Date() > parent.dueDate) {
      newPaymentStatus = PAYMENT_STATUS.OVERDUE;
    }

    const parentUpdate = {
      remainingBalance: newRemainingBalance,
      partiallyPaidAmount: newPartiallyPaidAmount,
      paymentStatus: newPaymentStatus,
      status: newRemainingBalance === 0 ? JOURNAL_STATUS.SETTLED : JOURNAL_STATUS.PARTIALLY_SETTLED,
      $push: { 
        relatedTransactions: childTx._id,
        settlements: {
          transactionId: childTx._id,
          amount: paymentData.amount,
          date: childData.transactionDate
        }
      }
    };

    await transactionRepository.updateTransaction(parent._id, businessId, parentUpdate);

    // 6. Update Customer/Vendor balances
    if (isReceivable && parent.customerId) {
      await customerRepository.updateReceivableBalance(parent.customerId._id, -paymentData.amount);
    } else if (!isReceivable && parent.vendorId) {
      await vendorRepository.updatePayableBalance(parent.vendorId._id, -paymentData.amount);
    }

    return childTx;
  }

  /**
   * Helper: Update account balance based on side (debit/credit) and account normal balance.
   * @private
   */
  async _updateAccountBalance(accountId, amount, side) {
    const account = await accountRepository.findById(accountId);
    if (!account) throw new ApiError(500, `Account ${accountId} not found`);
    let delta = 0;
    if (side === 'debit') {
      // Debit entry: increases debit-normal accounts, decreases credit-normal accounts
      delta = account.normalBalance === 'Debit' ? amount : -amount;
    } else {
      // Credit entry: increases credit-normal accounts, decreases debit-normal accounts
      delta = account.normalBalance === 'Credit' ? amount : -amount;
    }
    await accountRepository.updateRunningBalance(accountId, delta);
  }

  /**
   * Create multiple transactions in bulk (for Excel import).
   */
  async createBulkTransactions(entriesArray, userId, ipAddress) {
    const results = { successful: 0, failed: [] };
    for (const entry of entriesArray) {
      try {
        await this.createTransaction(entry, userId, ipAddress);
        results.successful++;
      } catch (error) {
        results.failed.push({ row: entry.originalRow, error: error.message });
      }
    }
    return results;
  }

  /**
   * Edit an existing transaction.
   */
  async editTransaction(transactionId, businessId, updateData, userId, ipAddress) {
    const original = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!original) throw new ApiError(404, 'Transaction not found');
    if (original.status === JOURNAL_STATUS.REVERSED) throw new ApiError(400, 'Cannot edit a reversed transaction');
    if (original.partiallyPaidAmount > 0) throw new ApiError(400, 'Cannot edit a transaction that has payments applied against it');

    delete updateData.businessId;

    const amountChanged = updateData.amount && updateData.amount !== original.amount;
    const debitChanged = updateData.debitAccountId && updateData.debitAccountId.toString() !== original.debitAccountId._id.toString();
    const creditChanged = updateData.creditAccountId && updateData.creditAccountId.toString() !== original.creditAccountId._id.toString();

    // Prevent changing amount on AR/AP transactions if it breaks balance logic (simplified for Phase 1)
    if (amountChanged && (original.transactionType === TRANSACTION_TYPES.CREDIT_SALE || original.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE)) {
        throw new ApiError(400, 'Cannot edit amount of a Credit Sale/Purchase directly. Please reverse and recreate.');
    }

    if (debitChanged || creditChanged || amountChanged) {
      const newDebitId = debitChanged ? updateData.debitAccountId : original.debitAccountId._id;
      const newCreditId = creditChanged ? updateData.creditAccountId : original.creditAccountId._id;
      if (newDebitId.toString() === newCreditId.toString()) {
        throw new ApiError(400, 'Debit and credit accounts must be different');
      }
      if (debitChanged) {
        const acc = await accountRepository.findOneByBusinessAndId(businessId, newDebitId);
        if (!acc) throw new ApiError(400, 'Invalid debit account');
      }
      if (creditChanged) {
        const acc = await accountRepository.findOneByBusinessAndId(businessId, newCreditId);
        if (!acc) throw new ApiError(400, 'Invalid credit account');
      }
    }

    const updated = await transactionRepository.updateTransaction(transactionId, businessId, {
      ...updateData,
      lastModifiedBy: userId,
    });
    if (!updated) throw new ApiError(404, 'Transaction not found after update');

    if (amountChanged || debitChanged || creditChanged) {
      await this._updateAccountBalance(original.debitAccountId._id, original.amount, 'debit');
      await this._updateAccountBalance(original.creditAccountId._id, original.amount, 'credit');
      
      const finalDebitId = debitChanged ? updateData.debitAccountId : original.debitAccountId._id;
      const finalCreditId = creditChanged ? updateData.creditAccountId : original.creditAccountId._id;
      const finalAmount = amountChanged ? updateData.amount : original.amount;
      
      await this._updateAccountBalance(finalDebitId, finalAmount, 'debit');
      await this._updateAccountBalance(finalCreditId, finalAmount, 'credit');
    }

    await auditService.logUpdate(
      ENTITY_TYPES.JOURNAL_ENTRY,
      transactionId,
      businessId,
      userId,
      original,
      updated.toObject(),
      ipAddress
    );

    return updated;
  }

  /**
   * Delete a transaction by creating a reversal entry (soft delete).
   * Also rolls back customer/vendor balances if applicable.
   */
  async deleteTransaction(transactionId, businessId, userId, ipAddress) {
    const original = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!original) throw new ApiError(404, 'Transaction not found');
    if (original.status === JOURNAL_STATUS.REVERSED) throw new ApiError(400, 'Transaction already reversed');
    if (original.partiallyPaidAmount > 0) throw new ApiError(400, 'Cannot reverse a transaction that has payments applied. Reverse the payments first.');

    // Create reversal entry
    const reversalData = {
      businessId,
      transactionDate: new Date(),
      description: `Reversal of: ${original.description}`,
      transactionType: original.transactionType,
      amount: original.amount,
      debitAccountId: original.creditAccountId._id,
      creditAccountId: original.debitAccountId._id,
      inputMethod: original.inputMethod,
      status: JOURNAL_STATUS.POSTED,
      reversalOf: original._id,
      createdBy: userId,
      lastModifiedBy: userId,
    };
    const reversal = await transactionRepository.createTransaction(reversalData);

    // Revert Account Balances
    await this._updateAccountBalance(reversal.debitAccountId, original.amount, 'debit');
    await this._updateAccountBalance(reversal.creditAccountId, original.amount, 'credit');

    // Revert Customer/Vendor Balances
    if (original.transactionType === TRANSACTION_TYPES.CREDIT_SALE && original.customerId) {
        await customerRepository.updateReceivableBalance(original.customerId._id, -original.amount);
    } else if (original.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE && original.vendorId) {
        await vendorRepository.updatePayableBalance(original.vendorId._id, -original.amount);
    }

    // Mark original as reversed
    await transactionRepository.updateTransaction(transactionId, businessId, { status: JOURNAL_STATUS.REVERSED, paymentStatus: null, remainingBalance: 0 });

    await auditService.logReversal(
      ENTITY_TYPES.JOURNAL_ENTRY,
      transactionId,
      businessId,
      userId,
      original,
      { reversalId: reversal._id },
      ipAddress
    );

    return reversal;
  }

  /**
   * Get filtered transaction history.
   */
  async getTransactionHistory(businessId, filters, pagination) {
    return transactionRepository.findManyWithFilters(businessId, filters, pagination);
  }

  /**
   * Get single transaction by ID with details.
   */
  async getTransactionById(transactionId, businessId) {
    const transaction = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!transaction) throw new ApiError(404, 'Transaction not found');
    const auditTrail = await auditService.getAuditTrail(ENTITY_TYPES.JOURNAL_ENTRY, transactionId);
    return { ...transaction, auditTrail: auditTrail.data };
  }

  /**
   * Get outstanding balances (Receivables or Payables)
   */
  async getOutstandingBalances(businessId, type) {
    if (type === 'receivable') {
      return transactionRepository.getOutstandingReceivables(businessId);
    } else if (type === 'payable') {
      return transactionRepository.getOutstandingPayables(businessId);
    } else {
      throw new ApiError(400, 'Invalid outstanding balance type. Use "receivable" or "payable"');
    }
  }

  /**
   * Get settlement history for a parent transaction.
   */
  async getSettlementHistory(parentTransactionId, businessId) {
    return transactionRepository.findByParentTransaction(parentTransactionId, businessId);
  }

  /**
   * Recalculate running balance for a specific account.
   */
  async recalculateAccountBalance(businessId, accountId) {
    const transactions = await transactionRepository.getByAccount(businessId, accountId, new Date(0), new Date());
    let balance = 0;
    for (const tx of transactions) {
      const isDebit = tx.debitAccountId._id.toString() === accountId;
      const account = await accountRepository.findById(accountId);
      if (isDebit) {
        balance += (account.normalBalance === 'Debit' ? tx.amount : -tx.amount);
      } else {
        balance += (account.normalBalance === 'Credit' ? tx.amount : -tx.amount);
      }
    }
    await accountRepository.updateRunningBalance(accountId, balance - (await accountRepository.findById(accountId)).runningBalance);
    return balance;
  }
}

module.exports = new TransactionService();