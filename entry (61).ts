import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const actions = await base44.asServiceRole.entities.ActionItem.list("-created_date", 200);

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const recentActions = actions.filter(a => new Date(a.created_date) > thirtyDaysAgo);
    const completed = actions.filter(a => a.status === 'completed');
    const overdue = actions.filter(a => {
      if (!a.due_date || a.status === 'completed') return false;
      return new Date(a.due_date) < now;
    });

    const byPriority = {
      critical: actions.filter(a => a.priority === 'critical' && a.status !== 'completed').length,
      high: actions.filter(a => a.priority === 'high' && a.status !== 'completed').length,
      medium: actions.filter(a => a.priority === 'medium' && a.status !== 'completed').length,
      low: actions.filter(a => a.priority === 'low' && a.status !== 'completed').length
    };

    const bySource = {
      audit: actions.filter(a => a.source_type === 'compliance_audit').length,
      prediction: actions.filter(a => a.source_type === 'risk_prediction').length,
      assessment: actions.filter(a => a.source_type === 'risk_assessment').length,
      manual: actions.filter(a => a.source_type === 'manual').length
    };

    const completionRate = actions.length > 0 
      ? ((completed.length / actions.length) * 100).toFixed(1)
      : 0;

    const prompt = `As an action management analyst, provide an executive summary of action item progress:

OVERALL METRICS:
- Total Actions: ${actions.length}
- Completed: ${completed.length} (${completionRate}%)
- In Progress: ${actions.filter(a => a.status === 'in_progress').length}
- Pending: ${actions.filter(a => a.status === 'pending').length}
- Overdue: ${overdue.length}
- New (Last 30 days): ${recentActions.length}

PRIORITY BREAKDOWN (Open Items):
- Critical: ${byPriority.critical}
- High: ${byPriority.high}
- Medium: ${byPriority.medium}
- Low: ${byPriority.low}

SOURCE BREAKDOWN:
- Audit Recommendations: ${bySource.audit}
- Risk Predictions: ${bySource.prediction}
- Risk Assessments: ${bySource.assessment}
- Manual: ${bySource.manual}

TOP OVERDUE ITEMS:
${overdue.slice(0, 5).map(a => {
  const daysOverdue = Math.floor((now - new Date(a.due_date)) / (1000 * 60 * 60 * 24));
  return `- ${a.title} (${daysOverdue} days overdue, ${a.priority} priority)`;
}).join('\n')}

Provide:
1. Executive summary of progress
2. Key concerns and bottlenecks
3. Performance trends
4. Priority recommendations for leadership`;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: {
          executive_summary: { type: "string" },
          key_concerns: {
            type: "array",
            items: { type: "string" }
          },
          trends: {
            type: "array",
            items: { type: "string" }
          },
          recommendations: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    });

    return Response.json({
      success: true,
      summary: result,
      metrics: {
        total: actions.length,
        completed: completed.length,
        completion_rate: parseFloat(completionRate),
        overdue: overdue.length,
        by_priority: byPriority,
        by_source: bySource
      }
    });

  } catch (error) {
    console.error('Progress summary error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});