import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { jsPDF } from 'npm:jspdf@4.0.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }
    const { recipientEmails, reportConfig } = await req.json();

    // Fetch all compliance data
    const requirements = await base44.asServiceRole.entities.ComplianceRequirement.list("-created_date", 500);
    const risks = await base44.asServiceRole.entities.RiskAssessment.list("-created_date", 500);
    const audits = await base44.asServiceRole.entities.ComplianceAudit.list("-audit_date", 10);
    const actions = await base44.asServiceRole.entities.ActionItem.list("-created_date", 200);

    // Calculate comprehensive statistics
    const complianceStats = {
      total: requirements.length,
      compliant: requirements.filter(r => r.status === 'compliant').length,
      in_progress: requirements.filter(r => r.status === 'in_progress').length,
      partial: requirements.filter(r => r.status === 'partial').length,
      non_compliant: requirements.filter(r => r.status === 'non_compliant').length,
      not_started: requirements.filter(r => r.status === 'not_started').length,
      overdue: requirements.filter(r => r.due_date && new Date(r.due_date) < new Date() && r.status !== 'compliant').length
    };

    const riskStats = {
      total: risks.length,
      critical: risks.filter(r => r.risk_level === 'critical').length,
      high: risks.filter(r => r.risk_level === 'high').length,
      medium: risks.filter(r => r.risk_level === 'medium').length,
      low: risks.filter(r => r.risk_level === 'low').length,
      approved: risks.filter(r => r.workflow_status === 'approved').length,
      pending: risks.filter(r => r.workflow_status === 'pending_review').length
    };

    const actionStats = {
      total: actions.length,
      pending: actions.filter(a => a.status === 'pending').length,
      in_progress: actions.filter(a => a.status === 'in_progress').length,
      completed: actions.filter(a => a.status === 'completed').length,
      blocked: actions.filter(a => a.status === 'blocked').length,
      overdue: actions.filter(a => a.due_date && new Date(a.due_date) < new Date() && a.status !== 'completed').length
    };

    const overallScore = complianceStats.total > 0 
      ? Math.round((complianceStats.compliant / complianceStats.total) * 100) 
      : 0;

    // Generate PDF Report
    const doc = new jsPDF();
    let yPos = 20;

    // Header
    doc.setFillColor(16, 185, 129);
    doc.rect(0, 0, 210, 35, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.text('Compliance Report', 20, 20);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 20, 28);
    yPos = 45;

    // Executive Summary Section
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text('Executive Summary', 20, yPos);
    yPos += 10;

    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    const summaryText = `Overall compliance score: ${overallScore}%. ${complianceStats.compliant} of ${complianceStats.total} requirements are fully compliant. ${complianceStats.overdue} requirements are overdue. ${riskStats.critical + riskStats.high} high-priority risks identified. ${actionStats.overdue} action items are overdue.`;
    const summaryLines = doc.splitTextToSize(summaryText, 170);
    doc.text(summaryLines, 20, yPos);
    yPos += summaryLines.length * 5 + 10;

    // Compliance Status Section
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text('Compliance Status', 20, yPos);
    yPos += 10;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text(`Total Requirements: ${complianceStats.total}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(16, 185, 129);
    doc.text(`✓ Compliant: ${complianceStats.compliant} (${Math.round((complianceStats.compliant/complianceStats.total)*100)}%)`, 25, yPos);
    yPos += 6;
    doc.setTextColor(59, 130, 246);
    doc.text(`⟳ In Progress: ${complianceStats.in_progress}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(245, 158, 11);
    doc.text(`◐ Partial: ${complianceStats.partial}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(239, 68, 68);
    doc.text(`✗ Non-Compliant: ${complianceStats.non_compliant}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(100, 116, 139);
    doc.text(`○ Not Started: ${complianceStats.not_started}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(239, 68, 68);
    doc.text(`⚠ Overdue: ${complianceStats.overdue}`, 25, yPos);
    yPos += 15;

    // Risk Assessment Section
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text('Risk Assessment Summary', 20, yPos);
    yPos += 10;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text(`Total Risk Assessments: ${riskStats.total}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(239, 68, 68);
    doc.text(`Critical: ${riskStats.critical}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(249, 115, 22);
    doc.text(`High: ${riskStats.high}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(245, 158, 11);
    doc.text(`Medium: ${riskStats.medium}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(59, 130, 246);
    doc.text(`Low: ${riskStats.low}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(16, 185, 129);
    doc.text(`Approved: ${riskStats.approved}`, 25, yPos);
    yPos += 15;

    // Action Items Section
    if (yPos > 240) {
      doc.addPage();
      yPos = 20;
    }

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text('Action Items Status', 20, yPos);
    yPos += 10;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text(`Total Actions: ${actionStats.total}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(245, 158, 11);
    doc.text(`Pending: ${actionStats.pending}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(59, 130, 246);
    doc.text(`In Progress: ${actionStats.in_progress}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(16, 185, 129);
    doc.text(`Completed: ${actionStats.completed}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(239, 68, 68);
    doc.text(`Blocked: ${actionStats.blocked}`, 25, yPos);
    yPos += 6;
    doc.setTextColor(239, 68, 68);
    doc.text(`Overdue: ${actionStats.overdue}`, 25, yPos);
    yPos += 15;

    // Critical Items Requiring Attention
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text('Critical Items Requiring Attention', 20, yPos);
    yPos += 10;

    const criticalReqs = requirements.filter(r => 
      (r.priority === 'critical' || r.priority === 'high') && r.status !== 'compliant'
    ).slice(0, 5);

    if (criticalReqs.length === 0) {
      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      doc.setTextColor(16, 185, 129);
      doc.text('✓ No critical items requiring immediate attention', 25, yPos);
      yPos += 10;
    } else {
      doc.setFontSize(9);
      doc.setFont(undefined, 'normal');
      criticalReqs.forEach(req => {
        if (yPos > 270) {
          doc.addPage();
          yPos = 20;
        }
        doc.setTextColor(0, 0, 0);
        doc.setFont(undefined, 'bold');
        doc.text(`${req.clause_number}: ${req.clause_title}`, 25, yPos);
        yPos += 5;
        doc.setFont(undefined, 'normal');
        doc.setTextColor(100, 116, 139);
        doc.text(`Status: ${req.status.replace('_', ' ')} | Priority: ${req.priority}`, 25, yPos);
        yPos += 8;
      });
    }

    // Recent Audit Findings
    if (audits.length > 0 && yPos < 240) {
      yPos += 5;
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(16);
      doc.setFont(undefined, 'bold');
      doc.text('Latest Audit Findings', 20, yPos);
      yPos += 10;

      const latestAudit = audits[0];
      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      doc.text(`Audit Date: ${new Date(latestAudit.audit_date).toLocaleDateString()}`, 25, yPos);
      yPos += 6;
      doc.text(`Overall Score: ${latestAudit.overall_score}/100`, 25, yPos);
      yPos += 6;
      if (latestAudit.findings && latestAudit.findings.length > 0) {
        doc.text(`Findings: ${latestAudit.findings.length}`, 25, yPos);
      }
    }

    // Generate PDF buffer
    const pdfBytes = doc.output('arraybuffer');

    // Send email to recipients if provided
    if (recipientEmails && recipientEmails.length > 0) {
      for (const email of recipientEmails) {
        await base44.integrations.Core.SendEmail({
          to: email,
          subject: `Automated Compliance Report - ${new Date().toLocaleDateString()}`,
          body: `
            <h2>Automated Compliance Report</h2>
            <p>Please find attached your automated compliance report.</p>
            
            <h3>Key Metrics:</h3>
            <ul>
              <li>Overall Compliance Score: <strong>${overallScore}%</strong></li>
              <li>Compliant Requirements: <strong>${complianceStats.compliant}/${complianceStats.total}</strong></li>
              <li>Critical/High Risks: <strong>${riskStats.critical + riskStats.high}</strong></li>
              <li>Overdue Actions: <strong>${actionStats.overdue}</strong></li>
            </ul>
            
            <p>Generated on ${new Date().toLocaleString()}</p>
          `
        });
      }
    }

    return Response.json({
      success: true,
      stats: {
        compliance: complianceStats,
        risks: riskStats,
        actions: actionStats,
        overallScore
      },
      emailsSent: recipientEmails ? recipientEmails.length : 0
    });

  } catch (error) {
    console.error('Error generating automated report:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});