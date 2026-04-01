/**
 * deadlineAlertMonitor
 * 
 * Runs daily. Checks 4 entity types for upcoming deadlines and sends
 * email + in-app notifications to responsible persons at 30, 14, and 7 days.
 * 
 * Covers:
 *  - Document expiry dates  → uploaded_by (or created_by)
 *  - AuditPlan dates        → assigned_auditor
 *  - ComplianceRequirement  → assigned_to
 *  - ActionItem due dates   → assigned_to
 * 
 * Deduplication: one notification per entity+window per 2-day window
 * (prevents re-sending if the job runs twice by accident).
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const ALERT_DAYS = [30, 14, 7];

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

function daysUntil(dateString, today) {
  const target = new Date(dateString);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function matchesWindow(days) {
  return ALERT_DAYS.includes(days);
}

function buildEmail({ subject, headline, color, itemTitle, itemMeta, recipientNote }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:${color};padding:24px 28px">
        <h2 style="color:white;margin:0;font-size:18px">${headline}</h2>
      </div>
      <div style="padding:28px;background:white">
        <div style="border-left:4px solid ${color};background:#f8fafc;border-radius:0 6px 6px 0;padding:14px 16px;margin-bottom:20px">
          <p style="margin:0 0 6px;font-weight:bold;color:#1e293b;font-size:15px">${itemTitle}</p>
          <p style="margin:0;color:#64748b;font-size:13px">${itemMeta}</p>
        </div>
        <p style="color:#374151;font-size:14px">${recipientNote}</p>
        <p style="color:#94a3b8;font-size:12px;margin-top:24px;border-top:1px solid #f1f5f9;padding-top:12px">
          FSMS Compliance Tracker — automated deadline alert. Please do not reply to this email.
        </p>
      </div>
    </div>`;
}

async function alreadyNotified(base44, entityId, entityType, daysWindow, todayStr) {
  // Check if a notification was created for this entity+window in the last 2 days
  const tag = `deadline_${daysWindow}d`;
  const recent = await base44.asServiceRole.entities.Notification.filter({
    entity_id: entityId,
    entity_type: entityType,
    type: tag,
  }, '-created_date', 5);

  return recent.some(n => {
    const created = new Date(n.created_date);
    const daysSince = (new Date(todayStr) - created) / (1000 * 60 * 60 * 24);
    return daysSince < 2;
  });
}

async function sendAlert(base44, { to, subject, entityId, entityType, daysWindow, emailBody, inAppTitle, inAppMessage }) {
  const tag = `deadline_${daysWindow}d`;

  // In-app notification
  await base44.asServiceRole.entities.Notification.create({
    recipient_email: to,
    title: inAppTitle,
    message: inAppMessage,
    type: tag,
    entity_type: entityType,
    entity_id: entityId,
    is_read: false,
  });

  // Email
  await base44.asServiceRole.integrations.Core.SendEmail({
    to,
    subject,
    body: emailBody,
  });
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = dateStr(today);

    let sent = 0;
    const log = [];

    // ── 1. EXPIRING DOCUMENTS ──────────────────────────────────────────
    const documents = await base44.asServiceRole.entities.Document.list('-expiry_date', 500);

    for (const doc of documents) {
      if (!doc.expiry_date) continue;

      const days = daysUntil(doc.expiry_date, today);
      if (!matchesWindow(days)) continue;

      const to = doc.uploaded_by || doc.created_by;
      if (!to) continue;

      if (await alreadyNotified(base44, doc.id, 'Document', days, todayStr)) continue;

      const label = doc.title || doc.file_name;
      await sendAlert(base44, {
        to,
        subject: `📄 Document Expiring in ${days} Days: ${label}`,
        entityId: doc.id,
        entityType: 'Document',
        daysWindow: days,
        inAppTitle: `Document expiring in ${days} days`,
        inAppMessage: `"${label}" expires on ${doc.expiry_date}. Please renew or update this document.`,
        emailBody: buildEmail({
          subject: `Document expiring in ${days} days`,
          headline: `📄 Document Expiry Alert — ${days} Days Remaining`,
          color: days <= 7 ? '#dc2626' : days <= 14 ? '#d97706' : '#059669',
          itemTitle: label,
          itemMeta: `Category: ${doc.category || 'N/A'} &nbsp;|&nbsp; Expires: <strong>${doc.expiry_date}</strong> &nbsp;|&nbsp; ${days} days remaining`,
          recipientNote: `Please renew or replace this document before it expires. Log in to the Compliance Tracker to upload a new version.`,
        }),
      });

      log.push({ type: 'Document', id: doc.id, to, days });
      sent++;
    }

    // ── 2. AUDIT PLANS ─────────────────────────────────────────────────
    const auditPlans = await base44.asServiceRole.entities.AuditPlan.list('-suggested_date', 500);

    for (const plan of auditPlans) {
      if (!plan.suggested_date) continue;
      if (['completed', 'cancelled'].includes(plan.status)) continue;

      const days = daysUntil(plan.suggested_date, today);
      if (!matchesWindow(days)) continue;

      const to = plan.assigned_auditor;
      if (!to) continue;

      if (await alreadyNotified(base44, plan.id, 'AuditPlan', days, todayStr)) continue;

      await sendAlert(base44, {
        to,
        subject: `🔍 Audit Due in ${days} Days: ${plan.title}`,
        entityId: plan.id,
        entityType: 'AuditPlan',
        daysWindow: days,
        inAppTitle: `Audit due in ${days} days`,
        inAppMessage: `"${plan.title}" is scheduled for ${plan.suggested_date}. Status: ${plan.status?.replace(/_/g, ' ')}.`,
        emailBody: buildEmail({
          headline: `🔍 Upcoming Audit — ${days} Days to Go`,
          color: days <= 7 ? '#7c3aed' : '#3b82f6',
          itemTitle: plan.title,
          itemMeta: `Type: ${plan.audit_type?.replace(/_/g, ' ') || 'N/A'} &nbsp;|&nbsp; Date: <strong>${plan.suggested_date}</strong> &nbsp;|&nbsp; Status: ${plan.status?.replace(/_/g, ' ')}`,
          recipientNote: `You are the assigned auditor for this audit. Please ensure all preparation is complete before the scheduled date.`,
        }),
      });

      log.push({ type: 'AuditPlan', id: plan.id, to, days });
      sent++;
    }

    // ── 3. COMPLIANCE REQUIREMENTS ─────────────────────────────────────
    const requirements = await base44.asServiceRole.entities.ComplianceRequirement.list('-due_date', 500);

    for (const req of requirements) {
      if (!req.due_date) continue;
      if (req.status === 'compliant') continue;

      const days = daysUntil(req.due_date, today);
      if (!matchesWindow(days)) continue;

      const to = req.assigned_to;
      if (!to) continue;

      if (await alreadyNotified(base44, req.id, 'ComplianceRequirement', days, todayStr)) continue;

      const label = `${req.clause_number} – ${req.clause_title}`;
      await sendAlert(base44, {
        to,
        subject: `⚠️ Compliance Requirement Due in ${days} Days: ${req.clause_number}`,
        entityId: req.id,
        entityType: 'ComplianceRequirement',
        daysWindow: days,
        inAppTitle: `Requirement due in ${days} days`,
        inAppMessage: `"${label}" is due on ${req.due_date}. Current status: ${req.status?.replace(/_/g, ' ')}.`,
        emailBody: buildEmail({
          headline: `⚠️ Compliance Deadline — ${days} Days Remaining`,
          color: days <= 7 ? '#dc2626' : days <= 14 ? '#d97706' : '#059669',
          itemTitle: label,
          itemMeta: `Section: ${req.section || 'N/A'} &nbsp;|&nbsp; Status: ${req.status?.replace(/_/g, ' ')} &nbsp;|&nbsp; Due: <strong>${req.due_date}</strong> &nbsp;|&nbsp; Priority: ${req.priority || 'medium'}`,
          recipientNote: `Please update the compliance status or add evidence in the Compliance Tracker before the due date.`,
        }),
      });

      log.push({ type: 'ComplianceRequirement', id: req.id, to, days });
      sent++;
    }

    // ── 4. ACTION ITEMS ────────────────────────────────────────────────
    const actions = await base44.asServiceRole.entities.ActionItem.list('-due_date', 500);

    for (const action of actions) {
      if (!action.due_date) continue;
      if (['completed', 'cancelled'].includes(action.status)) continue;

      const days = daysUntil(action.due_date, today);
      if (!matchesWindow(days)) continue;

      const to = action.assigned_to;
      if (!to) continue;

      if (await alreadyNotified(base44, action.id, 'ActionItem', days, todayStr)) continue;

      await sendAlert(base44, {
        to,
        subject: `📋 Action Item Due in ${days} Days: ${action.title}`,
        entityId: action.id,
        entityType: 'ActionItem',
        daysWindow: days,
        inAppTitle: `Action item due in ${days} days`,
        inAppMessage: `"${action.title}" is due on ${action.due_date}. Priority: ${action.priority}.`,
        emailBody: buildEmail({
          headline: `📋 Action Item Deadline — ${days} Days Remaining`,
          color: action.priority === 'critical' ? '#dc2626' : days <= 7 ? '#d97706' : '#3b82f6',
          itemTitle: action.title,
          itemMeta: `Priority: ${action.priority} &nbsp;|&nbsp; Status: ${action.status?.replace(/_/g, ' ')} &nbsp;|&nbsp; Due: <strong>${action.due_date}</strong>${action.clause_reference ? ` &nbsp;|&nbsp; Clause: ${action.clause_reference}` : ''}`,
          recipientNote: `Please complete or update this action item in the Compliance Tracker before the deadline.`,
        }),
      });

      log.push({ type: 'ActionItem', id: action.id, to, days });
      sent++;
    }

    console.log(`deadlineAlertMonitor: ${sent} alerts sent`, JSON.stringify(log));

    return Response.json({
      success: true,
      alerts_sent: sent,
      breakdown: {
        documents: log.filter(l => l.type === 'Document').length,
        audit_plans: log.filter(l => l.type === 'AuditPlan').length,
        requirements: log.filter(l => l.type === 'ComplianceRequirement').length,
        action_items: log.filter(l => l.type === 'ActionItem').length,
      },
      detail: log,
    });

  } catch (error) {
    console.error('deadlineAlertMonitor error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});