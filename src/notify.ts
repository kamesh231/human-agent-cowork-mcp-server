import type { CoworkConfig } from "./config.js";
import type { CoworkStore, Proposal, Action } from "./storage.js";

/**
 * NotificationDispatcher: Alert humans about events requiring attention.
 *
 * Triggers notifications on:
 * - New proposal in "suggest" mode (awaiting human decision)
 * - Trust changes above threshold (e.g., agent promoted or demoted)
 * - Handoff escalation (agent gave up)
 * - Policy violation detected (may need stricter rules)
 * - Bulk decision ready (multiple proposals batched)
 *
 * Supports multiple channels: email, Slack, webhook, log, in-app.
 * Respects notification preferences and rate limiting.
 */

export type NotificationChannel = "email" | "slack" | "webhook" | "log" | "in-app";

export interface NotificationPreference {
  user_id: string;
  channels: NotificationChannel[];
  event_types: NotificationEventType[];
  quiet_hours?: { start: string; end: string }; // "HH:mm" format, respects user timezone
  batch_enabled: boolean;
  batch_window_minutes: number;
}

export type NotificationEventType =
  | "proposal_needs_review"
  | "trust_change"
  | "trust_promoted"
  | "trust_demoted"
  | "handoff_escalated"
  | "policy_violation"
  | "bulk_decision_ready"
  | "approval_confirmed"
  | "override_recorded";

export interface Notification {
  id: string;
  event_type: NotificationEventType;
  recipient_id: string;
  channels: NotificationChannel[];
  title: string;
  body: string;
  context: Record<string, unknown>;
  sent_at: string | null;
  read_at: string | null;
  links: Array<{ text: string; href: string }>;
}

export class NotificationDispatcher {
  private preferences: Map<string, NotificationPreference> = new Map();
  private notifications: Notification[] = [];
  private pendingBatch: Map<string, Notification[]> = new Map(); // user_id → notifications

  constructor(
    private readonly store: CoworkStore,
    private readonly config: CoworkConfig,
  ) {}

  /**
   * Register notification preferences for a user.
   */
  setPreference(preference: NotificationPreference): void {
    this.preferences.set(preference.user_id, preference);
  }

  /**
   * Get preferences for a user (or default if not set).
   */
  getPreference(userId: string): NotificationPreference {
    return (
      this.preferences.get(userId) || {
        user_id: userId,
        channels: ["log"],
        event_types: [
          "proposal_needs_review",
          "trust_promoted",
          "trust_demoted",
        ],
        batch_enabled: false,
        batch_window_minutes: 5,
      }
    );
  }

  /**
   * Dispatch a notification immediately or queue for batch.
   * If user has batch_enabled, add to queue; otherwise send immediately.
   */
  async notify(params: {
    event_type: NotificationEventType;
    recipient_id: string;
    title: string;
    body: string;
    context: Record<string, unknown>;
    links?: Array<{ text: string; href: string }>;
  }): Promise<Notification> {
    const pref = this.getPreference(params.recipient_id);

    // Filter by user's event subscriptions
    if (!pref.event_types.includes(params.event_type)) {
      return {
        id: `notif_${Date.now()}`,
        event_type: params.event_type,
        recipient_id: params.recipient_id,
        channels: [],
        title: params.title,
        body: params.body,
        context: params.context,
        sent_at: null,
        read_at: null,
        links: params.links || [],
      };
    }

    const notification: Notification = {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      event_type: params.event_type,
      recipient_id: params.recipient_id,
      channels: pref.channels,
      title: params.title,
      body: params.body,
      context: params.context,
      sent_at: null,
      read_at: null,
      links: params.links || [],
    };

    if (pref.batch_enabled && this.shouldBatch(params.event_type)) {
      // Queue for batch dispatch
      const batch = this.pendingBatch.get(params.recipient_id) || [];
      batch.push(notification);
      this.pendingBatch.set(params.recipient_id, batch);
      return notification;
    }

    // Send immediately
    await this.send(notification, pref);
    return notification;
  }

  /**
   * Dispatch a proposal-needs-review notification.
   */
  async onProposalCreated(proposal: {
    id: string;
    action_id: string;
    trust_at_proposal: number;
  }): Promise<void> {
    // In production, look up who should review based on domain + role
    const reviewerId = "human"; // placeholder

    await this.notify({
      event_type: "proposal_needs_review",
      recipient_id: reviewerId,
      title: "New Proposal Awaiting Review",
      body: `Proposal ${proposal.id} from an agent (trust: ${proposal.trust_at_proposal.toFixed(2)}) requires your review.`,
      context: { proposal_id: proposal.id, trust_at_proposal: proposal.trust_at_proposal },
      links: [{ text: "Review Proposal", href: `/proposals/${proposal.id}` }],
    });
  }

  /**
   * Dispatch trust change notification.
   */
  async onTrustChanged(params: {
    agent_id: string;
    domain: string;
    previous_score: number;
    new_score: number;
    reason: string;
  }): Promise<void> {
    const eventType =
      params.new_score > params.previous_score ? "trust_promoted" : "trust_demoted";
    const delta = (params.new_score - params.previous_score).toFixed(3);

    await this.notify({
      event_type: eventType,
      recipient_id: "admin", // Go to admins for trust changes
      title: `Agent Trust ${eventType === "trust_promoted" ? "Promoted" : "Demoted"}`,
      body: `Agent "${params.agent_id}" in domain "${params.domain}" changed from ${params.previous_score.toFixed(2)} to ${params.new_score.toFixed(2)} (${delta}). Reason: ${params.reason}`,
      context: {
        agent_id: params.agent_id,
        domain: params.domain,
        previous_score: params.previous_score,
        new_score: params.new_score,
        delta: parseFloat(delta),
      },
    });
  }

  /**
   * Dispatch policy violation notification.
   */
  async onPolicyViolation(params: {
    agent_id: string;
    domain: string;
    field: string;
    rule_id: string;
    severity: "warning" | "hard_stop";
  }): Promise<void> {
    await this.notify({
      event_type: "policy_violation",
      recipient_id: "compliance",
      title: `Policy Violation: ${params.field}`,
      body: `Agent "${params.agent_id}" attempted to modify ${params.field} in ${params.domain}, violating rule ${params.rule_id}. Severity: ${params.severity}`,
      context: { ...params },
    });
  }

  /**
   * Send a notification through registered channels.
   */
  private async send(
    notification: Notification,
    _preference: NotificationPreference,
  ): Promise<void> {
    notification.sent_at = new Date().toISOString();
    this.notifications.push(notification);

    // In production, implement actual channel dispatch
    for (const channel of notification.channels) {
      switch (channel) {
        case "log":
          console.log(
            `[NOTIFICATION] ${notification.title}: ${notification.body}`,
          );
          break;
        case "email":
          // Implement email via SendGrid/AWS SES
          console.log(
            `[EMAIL] To: ${notification.recipient_id}, Subject: ${notification.title}`,
          );
          break;
        case "slack":
          // Implement via Slack API
          console.log(`[SLACK] @${notification.recipient_id}: ${notification.title}`);
          break;
        case "webhook":
          // Implement via webhook dispatcher
          console.log(`[WEBHOOK] POST to user's configured webhook`);
          break;
        case "in-app":
          // Store in user's notification inbox (same as this.notifications)
          break;
      }
    }
  }

  /**
   * Batch notifications for a user.
   * Returns a summary notification that includes all queued notifications.
   */
  async flushBatch(userId: string): Promise<Notification | null> {
    const queued = this.pendingBatch.get(userId);
    if (!queued || queued.length === 0) {
      return null;
    }

    const pref = this.getPreference(userId);
    const summary = {
      id: `notif_batch_${Date.now()}`,
      event_type: "bulk_decision_ready" as const,
      recipient_id: userId,
      channels: pref.channels,
      title: `${queued.length} Actions Pending Your Review`,
      body: `You have ${queued.length} notifications awaiting action.`,
      context: { queued_count: queued.length, notifications: queued },
      sent_at: null,
      read_at: null,
      links: [{ text: "Review All", href: "/notifications" }],
    };

    await this.send(summary, pref);
    this.pendingBatch.delete(userId);
    return summary;
  }

  /**
   * Determine if an event should be batched.
   * Typically, low-priority repeating events (logs) batch; high-priority events (trust promoted) don't.
   */
  private shouldBatch(eventType: NotificationEventType): boolean {
    const batchableEvents: NotificationEventType[] = [
      "approval_confirmed",
      "override_recorded",
    ];
    return batchableEvents.includes(eventType);
  }

  /**
   * Get all notifications for a user.
   */
  getForUser(userId: string): Notification[] {
    return this.notifications.filter((n) => n.recipient_id === userId);
  }

  /**
   * Mark notification as read.
   */
  markRead(notificationId: string): void {
    const notif = this.notifications.find((n) => n.id === notificationId);
    if (notif) {
      notif.read_at = new Date().toISOString();
    }
  }
}
