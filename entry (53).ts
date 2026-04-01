import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json();
    const { report_id, recipient_emails } = payload;

    if (!report_id || !recipient_emails || recipient_emails.length === 0) {
      return Response.json({ error: 'Missing required fields: report_id, recipient_emails' }, { status: 400 });
    }

    // Fetch the report
    const report = await base44.asServiceRole.entities.ComplianceReport.get(report_id);
    
    if (!report) {
      return Response.json({ error: 'Report not found' }, { status: 404 });
    }

    // Format email content
    const emailBody = `
Hello,

Please find attached your ${report.report_type} compliance report generated on ${report.report_date}.

COMPLIANCE SCORE: ${report.compliance_score}%

EXECUTIVE SUMMARY:
${report.executive_summary}

KEY FINDINGS:
${report.key_findings?.map((f, i) => `${i + 1}. ${f}`).join('\n')}

COMPLIANCE STATUS:
- Total Requirements: ${report.compliance_stats?.total_requirements || 0}
- Compliant: ${report.compliance_stats?.compliant || 0}
- In Progress: ${report.compliance_stats?.in_progress || 0}
- Non-Compliant: ${report.compliance_stats?.non_compliant || 0}
- Not Started: ${report.compliance_stats?.not_started || 0}

RISK ASSESSMENT:
- Critical Risks: ${report.risk_stats?.critical || 0}
- High Risks: ${report.risk_stats?.high || 0}
- Medium Risks: ${report.risk_stats?.medium || 0}
- Low Risks: ${report.risk_stats?.low || 0}

TASK COMPLETION: ${report.task_completion_rate}%

RECOMMENDED ACTIONS:
${report.action_plan?.map((a, i) => `${i + 1}. ${a.action} (Timeline: ${a.timeline})`).join('\n')}

For more details, log into the compliance application.

Best regards,
Compliance Reporting System
    `;

    // Send email to each recipient
    for (const email of recipient_emails) {
      await base44.integrations.Core.SendEmail({
        to: email,
        subject: `${report.report_type.charAt(0).toUpperCase() + report.report_type.slice(1)} Compliance Report - ${report.report_date}`,
        body: emailBody,
        from_name: 'Compliance Reporting'
      });
    }

    // Update report status
    await base44.asServiceRole.entities.ComplianceReport.update(report_id, {
      status: 'sent',
      email_recipients: recipient_emails,
      sent_date: new Date().toISOString()
    });

    return Response.json({
      success: true,
      message: `Report sent to ${recipient_emails.length} recipient(s)`
    });
  } catch (error) {
    console.error('Error sending report:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});