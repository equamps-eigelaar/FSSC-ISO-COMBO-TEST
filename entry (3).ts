import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, mapping, framework } = await req.json();

    const errors = [];
    const warnings = [];
    let validRecords = 0;

    // Validate each record
    for (let i = 0; i < data.length; i++) {
      const record = data[i];
      const recordNum = i + 1;

      // Check required mapped fields
      const clauseNum = getMappedValue(record, mapping, 'Clause Number');
      const title = getMappedValue(record, mapping, 'Clause Title');
      const status = getMappedValue(record, mapping, 'Status');

      if (!clauseNum) {
        errors.push(`Row ${recordNum}: Missing Clause Number`);
        continue;
      }

      if (!title) {
        warnings.push(`Row ${recordNum}: Missing Clause Title`);
      }

      // Validate status value
      const validStatuses = ['not_started', 'in_progress', 'partial', 'compliant', 'non_compliant'];
      if (status && !validStatuses.includes(status.toLowerCase())) {
        warnings.push(`Row ${recordNum}: Invalid status "${status}". Using "not_started".`);
      }

      // Check for duplicates in this import
      const duplicates = data.slice(i + 1).filter(
        r => getMappedValue(r, mapping, 'Clause Number') === clauseNum
      );
      if (duplicates.length > 0) {
        warnings.push(`Row ${recordNum}: Duplicate Clause Number ${clauseNum} found`);
      }

      validRecords++;
    }

    // Check for existing requirements in database
    const existingRequirements = await base44.entities.ComplianceRequirement?.list?.() || [];
    const importClauseNumbers = data
      .map(r => getMappedValue(r, mapping, 'Clause Number'))
      .filter(Boolean);

    const duplicatesInDB = importClauseNumbers.filter(num =>
      existingRequirements.some(req => req.clause_number === num)
    );

    if (duplicatesInDB.length > 0) {
      warnings.push(
        `${duplicatesInDB.length} requirements already exist in database. They will be updated.`
      );
    }

    const isValid = errors.length === 0;
    const summary = isValid
      ? `Validation passed: ${validRecords} records ready to import`
      : `Validation failed: ${errors.length} critical errors found`;

    return Response.json({
      validation: {
        isValid,
        errors,
        warnings,
        summary,
        totalRecords: data.length,
        validRecords,
        duplicatesInDB: duplicatesInDB.length,
      }
    });
  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});

function getMappedValue(record, mapping, field) {
  for (const [csvCol, mappedField] of Object.entries(mapping)) {
    if (mappedField === field && record[csvCol]) {
      return record[csvCol].toString().trim();
    }
  }
  return null;
}