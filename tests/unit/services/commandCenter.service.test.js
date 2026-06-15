'use strict';

jest.mock('../../../services/proactiveInsights.service', () => ({ getNeedsAttention: jest.fn() }));
jest.mock('../../../repositories/proposedAction.repository', () => ({ inbox: jest.fn() }));

const proactive = require('../../../services/proactiveInsights.service');
const repo      = require('../../../repositories/proposedAction.repository');
const cc        = require('../../../services/commandCenter.service');

const BIZ = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  proactive.getNeedsAttention.mockResolvedValue({ items: [] });
  repo.inbox.mockResolvedValue([]);
});

describe('commandCenter.getInbox', () => {
  it('wraps existing needs-attention items as read-only insight items', async () => {
    proactive.getNeedsAttention.mockResolvedValue({ items: [
      { id: 'anomaly_alerts', source: 'anomaly', level: 'warning', title: 'Unusual transactions detected', message: '3 look unusual', action: 'Review', actionTo: '/ai-analyst/anomalies' },
    ] });
    const out = await cc.getInbox(BIZ);
    const it = out.items.find(x => x.id === 'anomaly_alerts');
    expect(it.kind).toBe('insight');
    expect(it.actionable).toBe(false);
    expect(it.capability).toBe('bookkeeping');   // anomaly → bookkeeping review
    expect(it.actionTo).toBe('/ai-analyst/anomalies');
  });

  it('includes persisted queued ProposedActions as actionable items', async () => {
    repo.inbox.mockResolvedValue([
      { _id: 'a1', capability: 'tax', type: 'file_return', title: 'File GST-01', rationale: 'due in 3 days', confidence: 0.92 },
    ]);
    const out = await cc.getInbox(BIZ);
    const it = out.items.find(x => x.id === 'a1');
    expect(it.kind).toBe('action');
    expect(it.actionable).toBe(true);
    expect(it.capability).toBe('tax');
    expect(it.confidence).toBe(0.92);
  });

  it('actionable proposed actions sort ahead of informational insights', async () => {
    proactive.getNeedsAttention.mockResolvedValue({ items: [{ id: 'i1', source: 'finance', level: 'info', title: 'Insight' }] });
    repo.inbox.mockResolvedValue([{ _id: 'a1', capability: 'tax', type: 'x' }]);
    const out = await cc.getInbox(BIZ);
    expect(out.items[0].kind).toBe('action');
    expect(out.counts.actions).toBe(1);
    expect(out.counts.insights).toBe(1);
  });

  it('degrades gracefully when a source fails', async () => {
    proactive.getNeedsAttention.mockRejectedValue(new Error('down'));
    repo.inbox.mockResolvedValue([{ _id: 'a1', capability: 'tax', type: 'x' }]);
    const out = await cc.getInbox(BIZ);
    expect(out.items).toHaveLength(1);   // the action still shows
  });
});
