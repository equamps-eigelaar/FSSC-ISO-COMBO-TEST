import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Fetch all requirements that have a due date and assigned user and are not yet compliant
    const requirements = await base44.asServiceRole.entities.ComplianceRequirement.list('-due_date', 500);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const REMIND_AT_DAYS = [3, 7];
    let notificationsSent = 0;

    for (const req of requirements) {
      if (!req.due_date) continue;
      if (!req.assigned_to && !req.responsible_person) continue;
      if (req.status === 'compliant') continue;

      const dueDate = new Date(req.due_date);
      dueDate.setHours(0, 0, 0, 0);
      const daysUntilDue = Math.round((dueDate - today) / (1000 * 60 * 60 * 24));

      const isOverdue = daysUntilDue < 0;
      const shouldRemind = isOverdue || REMIND_AT_DAYS.includes(daysUntilDue);

      if (!shouldRemind) continue;

      const clauseLabel = `${req.clause_number} – ${req.clause_title}`;
      const actionUrl = `/RequirementDetail?id=${req.id}`;

      let title, message;
      if (isOverdue) {
        title = `⚠️ Overdue Requirement: ${req.clause_number}`;
        message = `Compliance requirement "${clauseLabel}" was due on ${req.due_date} and is now ${Math.abs(daysUntilDue)} day(s) overdue.`;
      } else {
        title = `📅 Due in ${daysUntilDue} day(s): ${req.clause_number}`;
        message = `Compliance requirement "${clauseLabel}" is due on ${req.due_date}. Current status: ${req.status.replace(/_/g, ' ')}.`;
      }

      // Determine recipients (assigned_to email + responsible_person if different)
      const recipientEmails = new Set();
      if (req.assigned_to) recipientEmails.add(req.assigned_to);

      // Check if we already sent this exact notification today (avoid duplicates)
      const todayStr = today.toISOString().split('T')[0];
      const existing = await base44.asServiceRole.entities.Notification.filter({
        entity_id: req.id,
        type: 'due_soon',
      }, '-created_date', 20);

      const alreadySentToday = existing.some(n => {
        const nDate = new Date(n.created_date).toISOString().split('T')[0];
        return nDate === todayStr;
      });

      if (alreadySentToday) continue;

      for (const email of recipientEmails) {
        // In-app notification
        await base44.asServiceRole.entities.Notification.create({
          recipient_email: email,
          title,
          message,
          type: 'due_soon',
          entity_type: 'ComplianceRequirement',
          entity_id: req.id,
          action_url: actionUrl,
          is_read: false,
        });

        // Email notification
        await base44.asServiceRole.integrations.Core.SendEmail({
          to: email,
          subject: title,
          body: `${message}\n\nLog in to the compliance tracker to take action:\nhttps://app.base44.com${actionUrl}`,
        });

        notificationsSent++;
      }
    }

    return Response.json({
      success: true,
      notifications_sent: notificationsSent,
      requirements_checked: requirements.length,
    });
  } catch (error) {
    console.error('checkRequirementDueDates error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});