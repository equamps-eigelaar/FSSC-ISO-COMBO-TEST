import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const actions = await base44.asServiceRole.entities.ActionItem.filter({
      status: { $in: ["pending", "in_progress"] }
    }, "-due_date", 200);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let notificationsSent = 0;

    for (const action of actions) {
      if (!action.due_date) continue;

      const dueDate = new Date(action.due_date);
      dueDate.setHours(0, 0, 0, 0);
      const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

      let shouldNotify = false;
      let message = '';

      // Overdue
      if (daysUntilDue < 0) {
        shouldNotify = true;
        message = `Action is ${Math.abs(daysUntilDue)} days overdue: ${action.title}`;
      }
      // High priority within 3 days
      else if (action.priority === 'high' && daysUntilDue <= 3) {
        shouldNotify = true;
        message = `High-priority action due in ${daysUntilDue} days: ${action.title}`;
      }
      // Critical priority within 5 days
      else if (action.priority === 'critical' && daysUntilDue <= 5) {
        shouldNotify = true;
        message = `Critical action due in ${daysUntilDue} days: ${action.title}`;
      }

      if (shouldNotify) {
        // Notify assigned user or admins
        const recipients = action.assigned_to 
          ? [action.assigned_to]
          : (await base44.asServiceRole.entities.User.filter({ role: 'admin' })).map(u => u.email);

        for (const email of recipients) {
          await base44.asServiceRole.entities.Notification.create({
            recipient_email: email,
            title: "Action Item Alert",
            message,
            type: "due_soon",
            entity_type: "ActionItem",
            entity_id: action.id,
            action_url: `/ActionItems?id=${action.id}`
          });
        }
        notificationsSent++;
      }
    }

    return Response.json({
      success: true,
      notifications_sent: notificationsSent,
      actions_checked: actions.length
    });

  } catch (error) {
    console.error('Check overdue actions error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});