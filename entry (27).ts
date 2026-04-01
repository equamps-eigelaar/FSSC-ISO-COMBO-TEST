import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const LIKELIHOOD_SCORES = {
  rare: 1,
  unlikely: 2,
  possible: 3,
  likely: 4,
  almost_certain: 5,
};

const SEVERITY_SCORES = {
  negligible: 1,
  minor: 2,
  moderate: 3,
  major: 4,
  catastrophic: 5,
};

function calculateRiskLevel(likelihood, severity) {
  const likelihoodScore = LIKELIHOOD_SCORES[likelihood] || 3;
  const severityScore = SEVERITY_SCORES[severity] || 3;
  const riskScore = likelihoodScore * severityScore;

  if (riskScore <= 4) return 'low';
  if (riskScore <= 9) return 'medium';
  if (riskScore <= 16) return 'high';
  return 'critical';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { likelihood, severity, hazard_type } = await req.json();

    if (!likelihood || !severity) {
      return Response.json({ error: 'likelihood and severity are required' }, { status: 400 });
    }

    const calculatedRiskLevel = calculateRiskLevel(likelihood, severity);
    const likelihoodScore = LIKELIHOOD_SCORES[likelihood];
    const severityScore = SEVERITY_SCORES[severity];
    const riskScore = likelihoodScore * severityScore;

    // Get historical data for similar risks
    const allRisks = await base44.entities.RiskAssessment.list('-created_date', 500);
    
    const similarRisks = allRisks.filter(r => 
      r.hazard_type === hazard_type &&
      r.likelihood === likelihood &&
      r.severity === severity
    );

    const avgResidualRisk = similarRisks.length > 0 
      ? similarRisks.filter(r => r.residual_risk).length / similarRisks.length
      : 0;

    // Recommend review frequency based on risk level
    const recommendedReviewDays = {
      low: 180,
      medium: 90,
      high: 60,
      critical: 30,
    }[calculatedRiskLevel];

    return Response.json({
      risk_level: calculatedRiskLevel,
      risk_score: riskScore,
      likelihood_score: likelihoodScore,
      severity_score: severityScore,
      similar_cases: similarRisks.length,
      historical_mitigation_rate: Math.round(avgResidualRisk * 100),
      recommended_review_days: recommendedReviewDays,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});