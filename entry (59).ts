import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const DOC_SCHEMAS = {
  tds: {
    type: "object",
    properties: {
      product_name: { type: "string" },
      product_code: { type: "string" },
      manufacturer: { type: "string" },
      physical_form: { type: "string" },
      color: { type: "string" },
      odor: { type: "string" },
      ph_range: { type: "string" },
      viscosity: { type: "string" },
      moisture_content: { type: "string" },
      shelf_life: { type: "string" },
      storage_conditions: { type: "string" },
      usage_instructions: { type: "string" },
      certifications: { type: "array", items: { type: "string" } },
      revision_date: { type: "string" },
    }
  },
  coa: {
    type: "object",
    properties: {
      product_name: { type: "string" },
      batch_number: { type: "string" },
      manufacturer: { type: "string" },
      test_date: { type: "string" },
      expiry_date: { type: "string" },
      test_results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            parameter: { type: "string" },
            result: { type: "string" },
            specification: { type: "string" },
            status: { type: "string", enum: ["pass", "fail", "pending"] }
          }
        }
      },
      overall_status: { type: "string", enum: ["approved", "rejected", "pending"] },
      approved_by: { type: "string" },
    }
  },
  allergen: {
    type: "object",
    properties: {
      product_name: { type: "string" },
      manufacturer: { type: "string" },
      contains: { type: "array", items: { type: "string" } },
      may_contain: { type: "array", items: { type: "string" } },
      free_from: { type: "array", items: { type: "string" } },
      facility_allergens: { type: "array", items: { type: "string" } },
      declaration_date: { type: "string" },
      valid_until: { type: "string" },
    }
  },
  haccp: {
    type: "object",
    properties: {
      product_name: { type: "string" },
      process_description: { type: "string" },
      hazards_identified: { type: "array", items: { type: "string" } },
      ccps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ccp_number: { type: "string" },
            hazard: { type: "string" },
            critical_limit: { type: "string" },
            monitoring: { type: "string" },
          }
        }
      },
      review_date: { type: "string" },
      approved_by: { type: "string" },
    }
  }
};

const REQUIRED_FIELDS = {
  tds: ["product_name", "manufacturer", "shelf_life", "storage_conditions", "revision_date"],
  coa: ["product_name", "batch_number", "test_date", "expiry_date", "overall_status"],
  allergen: ["product_name", "manufacturer", "contains", "declaration_date", "valid_until"],
  haccp: ["product_name", "hazards_identified", "ccps", "review_date"],
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { document_id, file_url, doc_type } = await req.json();

    if (!file_url || !doc_type) {
      return Response.json({ error: 'file_url and doc_type are required' }, { status: 400 });
    }

    const schema = DOC_SCHEMAS[doc_type];
    if (!schema) {
      return Response.json({ error: `Unknown doc_type: ${doc_type}` }, { status: 400 });
    }

    const prompts = {
      tds: "Extract all key fields from this Technical Data Sheet (TDS). Focus on product specifications, physical properties, shelf life, storage requirements, certifications, and revision date.",
      coa: "Extract all key fields from this Certificate of Analysis (CoA). Focus on batch number, test date, expiry date, all test parameters with their results and specifications, and overall approval status.",
      allergen: "Extract all allergen information from this Allergen Statement. List all allergens present, may-contain cross-contamination allergens, allergen-free claims, facility allergens, and declaration validity dates.",
      haccp: "Extract all key fields from this HACCP Summary. Focus on identified hazards, CCPs with critical limits, monitoring procedures, review dates, and approver details.",
    };

    // Use AI to extract structured data from the document
    const extracted = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `${prompts[doc_type]}\n\nExtract the data exactly as it appears in the document. For dates, use ISO format YYYY-MM-DD if possible.`,
      file_urls: [file_url],
      response_json_schema: schema,
    });

    // Validate required fields and flag issues
    const requiredFields = REQUIRED_FIELDS[doc_type] || [];
    const flags = [];
    const today = new Date();

    // Check missing required fields
    for (const field of requiredFields) {
      const val = extracted[field];
      const isEmpty = val === null || val === undefined || val === "" || (Array.isArray(val) && val.length === 0);
      if (isEmpty) {
        flags.push({
          type: "missing",
          severity: "high",
          field,
          message: `Required field "${field.replace(/_/g, ' ')}" is missing or empty`
        });
      }
    }

    // Check expiry dates
    const expiryFields = ["expiry_date", "valid_until", "revision_date", "review_date", "declaration_date", "test_date"];
    for (const f of expiryFields) {
      if (extracted[f]) {
        const d = new Date(extracted[f]);
        if (!isNaN(d)) {
          const daysUntilExpiry = Math.floor((d - today) / (1000 * 60 * 60 * 24));
          if (daysUntilExpiry < 0) {
            flags.push({ type: "expired", severity: "critical", field: f, message: `Document has expired (${extracted[f]})` });
          } else if (daysUntilExpiry < 30) {
            flags.push({ type: "expiring_soon", severity: "high", field: f, message: `Document expires in ${daysUntilExpiry} days (${extracted[f]})` });
          } else if (daysUntilExpiry < 90) {
            flags.push({ type: "expiring_soon", severity: "medium", field: f, message: `Document expires in ${daysUntilExpiry} days (${extracted[f]})` });
          }
        }
      }
    }

    // CoA-specific: flag failed tests
    if (doc_type === "coa" && extracted.test_results) {
      const failed = extracted.test_results.filter(t => t.status === "fail");
      if (failed.length > 0) {
        flags.push({
          type: "failed_test",
          severity: "critical",
          field: "test_results",
          message: `${failed.length} test(s) failed: ${failed.map(t => t.parameter).join(", ")}`
        });
      }
      if (extracted.overall_status === "rejected") {
        flags.push({ type: "rejected", severity: "critical", field: "overall_status", message: "CoA status is REJECTED" });
      }
    }

    // Allergen-specific: flag if high-risk allergens present
    if (doc_type === "allergen" && extracted.contains) {
      const highRisk = ["peanuts", "tree nuts", "milk", "eggs", "wheat", "soy", "fish", "shellfish", "sesame"];
      const found = extracted.contains.filter(a => highRisk.some(hr => a.toLowerCase().includes(hr)));
      if (found.length > 0) {
        flags.push({
          type: "allergen_present",
          severity: "high",
          field: "contains",
          message: `High-risk allergens present: ${found.join(", ")}`
        });
      }
    }

    // Save extracted data and flags back to the document record
    if (document_id) {
      await base44.asServiceRole.entities.Document.update(document_id, {
        ai_analysis: {
          analyzed: true,
          analyzed_date: new Date().toISOString(),
          extracted_data: extracted,
          compliance_status: flags.some(f => f.severity === "critical") ? "non_compliant"
            : flags.some(f => f.severity === "high") ? "requires_review"
            : flags.length === 0 ? "compliant" : "requires_review",
          issues_found: flags,
          confidence_score: Math.max(20, 100 - (flags.filter(f => f.type === "missing").length * 15)),
          summary: flags.length === 0
            ? `${doc_type.toUpperCase()} document looks complete and valid.`
            : `${flags.length} issue(s) found: ${flags.filter(f => f.severity === "critical").length} critical, ${flags.filter(f => f.severity === "high").length} high.`
        }
      });
    }

    return Response.json({ success: true, extracted, flags });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});