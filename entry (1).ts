import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Support both direct calls (with user session) and scheduled automation (no session)
    const isAuthenticated = await base44.auth.isAuthenticated();
    if (isAuthenticated) {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
      }
    }

    const [audits, predictions, existingActions] = await Promise.all([
      base44.asServiceRole.entities.ComplianceAudit.list("-audit_date", 5),
      base44.asServiceRole.entities.RiskPrediction.filter({ status: "active" }, "-prediction_date", 20),
      base44.asServiceRole.entities.ActionItem.list("-created_date", 200)
    ]);

    let actionsCreated = 0;

    // Extract actions from recent audits
    for (const audit of audits) {
      if (audit.status !== 'completed' || !audit.recommendations) continue;

      for (const recommendation of audit.recommendations) {
        // Check if action already exists
        const exists = existingActions.some(a => 
          a.source_id === audit.id && 
          a.description === recommendation
        );

        if (!exists) {
          const dueDate = new Date();
          dueDate.setDate(dueDate.getDate() + 30); // 30 days from now

          await base44.asServiceRole.entities.ActionItem.create({
            title: `Audit Recommendation`,
            description: recommendation,
            source_type: "compliance_audit",
            source_id: audit.id,
            priority: audit.overall_score < 70 ? "high" : "medium",
            status: "pending",
            due_date: dueDate.toISOString().split('T')[0]
          });
          actionsCreated++;
        }
      }
    }

    // Extract actions from risk predictions
    for (const prediction of predictions) {
      if (!prediction.recommended_actions) continue;

      for (const action of prediction.recommended_actions) {
        const exists = existingActions.some(a => 
          a.source_id === prediction.id && 
          a.description === action
        );

        if (!exists) {
          const dueDate = new Date();
          const timeframeDays = prediction.timeframe?.includes('30') ? 15 : 
                               prediction.timeframe?.includes('90') ? 45 : 30;
          dueDate.setDate(dueDate.getDate() + timeframeDays);

          await base44.asServiceRole.entities.ActionItem.create({
            title: `Risk Prevention: ${prediction.risk_area}`,
            description: action,
            source_type: "risk_prediction",
            source_id: prediction.id,
            priority: prediction.priority_score >= 70 ? "high" : "medium",
            status: "pending",
            due_date: dueDate.toISOString().split('T')[0]
          });
          actionsCreated++;
        }
      }
    }

    await base44.asServiceRole.entities.ActivityLog.create({
      activity_type: "review_completed",
      entity_type: "ActionItem",
      description: `Tracked ${actionsCreated} new action items from AI recommendations`,
      user_email: "system@automation"
    });

    return Response.json({
      success: true,
      actions_created: actionsCreated
    });

  } catch (error) {
    console.error('Action tracking error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});