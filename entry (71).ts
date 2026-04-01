import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { jsPDF } from 'npm:jspdf@4.0.0';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { batch_id } = await req.json();

        const batch = await base44.entities.RawMaterialBatch.get(batch_id);

        if (!batch) {
            return Response.json({ error: 'Batch not found' }, { status: 404 });
        }

        const doc = new jsPDF();
        const pageWidth = doc.internal.pageSize.width;

        // Header
        doc.setFillColor(16, 185, 129);
        doc.rect(0, 0, pageWidth, 40, 'F');
        
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(24);
        doc.text('CERTIFICATE OF COMPLIANCE', pageWidth / 2, 20, { align: 'center' });
        
        doc.setFontSize(10);
        doc.text('ISO 22000:2018 & TS 22002-4', pageWidth / 2, 30, { align: 'center' });

        // Certificate Number and Date
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
        doc.text(`Certificate No: COC-${batch.batch_number}`, 20, 55);
        doc.text(`Issue Date: ${new Date().toLocaleDateString()}`, pageWidth - 20, 55, { align: 'right' });

        // Material Information
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('Material Information', 20, 75);
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        let y = 85;

        doc.text(`Material Name:`, 20, y);
        doc.setFont(undefined, 'bold');
        doc.text(batch.material_name, 65, y);
        y += 8;

        doc.setFont(undefined, 'normal');
        doc.text(`Material Code:`, 20, y);
        doc.text(batch.material_code || 'N/A', 65, y);
        y += 8;

        doc.text(`Batch Number:`, 20, y);
        doc.setFont(undefined, 'bold');
        doc.text(batch.batch_number, 65, y);
        y += 8;

        doc.setFont(undefined, 'normal');
        doc.text(`Purchase Order:`, 20, y);
        doc.text(batch.po_number, 65, y);
        y += 8;

        doc.text(`Quantity:`, 20, y);
        doc.text(`${batch.quantity || 'N/A'} ${batch.unit || ''}`, 65, y);
        y += 15;

        // Supplier Information
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('Supplier Information', 20, y);
        y += 10;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.text(`Supplier:`, 20, y);
        doc.text(batch.supplier, 65, y);
        y += 8;

        doc.text(`Supplier Batch:`, 20, y);
        doc.text(batch.supplier_batch_number || 'N/A', 65, y);
        y += 15;

        // Dates
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('Date Information', 20, y);
        y += 10;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.text(`Manufacturing Date:`, 20, y);
        doc.text(batch.manufacturing_date ? new Date(batch.manufacturing_date).toLocaleDateString() : 'N/A', 65, y);
        y += 8;

        doc.text(`Expiry Date:`, 20, y);
        doc.text(batch.expiry_date ? new Date(batch.expiry_date).toLocaleDateString() : 'N/A', 65, y);
        y += 8;

        doc.text(`Received Date:`, 20, y);
        doc.text(batch.received_date ? new Date(batch.received_date).toLocaleDateString() : 'N/A', 65, y);
        y += 15;

        // Compliance Statement
        doc.setFillColor(240, 253, 244);
        doc.rect(15, y, pageWidth - 30, 35, 'F');
        
        doc.setFontSize(12);
        doc.setFont(undefined, 'bold');
        doc.text('Compliance Statement', 20, y + 10);
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        const statement = `This is to certify that the above material batch has been inspected and approved for use in packaging manufacturing operations. The material meets all requirements specified in ISO 22000:2018 and TS 22002-4 standards.`;
        const splitStatement = doc.splitTextToSize(statement, pageWidth - 40);
        doc.text(splitStatement, 20, y + 20);
        
        y += 50;

        // Food Safety Statement
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(0, 0, 0);
        doc.text('Food Safety & Packaging Product Statements', 20, y);
        y += 10;

        const foodSafetyStatements = [
            {
                title: '1. Food Contact Safety',
                body: 'This packaging material is confirmed to be manufactured from food-grade raw materials and is safe for direct or indirect food contact in accordance with applicable food contact regulations, including EU Regulation (EC) No 1935/2004 and FDA 21 CFR standards.',
            },
            {
                title: '2. Chemical & Toxicological Compliance',
                body: 'The material has been assessed to be free from harmful substances, heavy metals, and substances of very high concern (SVHCs) at levels that could pose a risk to human health or cause unacceptable organoleptic changes to food products.',
            },
            {
                title: '3. Allergen Statement',
                body: 'This packaging material does not intentionally contain any of the 14 major allergens as defined in EU Regulation (EU) No 1169/2011. No cross-contamination risk from allergen-containing materials has been identified in the manufacturing process.',
            },
            {
                title: '4. Microbiological Safety',
                body: 'The material is produced under hygienic manufacturing conditions in accordance with Good Manufacturing Practice (GMP) requirements of ISO/TS 22002-4. Microbiological contamination risk to food products is assessed as negligible under intended use conditions.',
            },
            {
                title: '5. Packaging Integrity & Barrier Properties',
                body: 'The material is confirmed to provide adequate barrier protection against physical, chemical, and microbiological contamination for the intended food application. Seal integrity and structural performance have been verified to maintain food safety throughout the supply chain.',
            },
        ];

        doc.setFontSize(9);
        for (const stmt of foodSafetyStatements) {
            if (y > 245) {
                doc.addPage();
                y = 20;
            }
            doc.setFont(undefined, 'bold');
            doc.setTextColor(16, 100, 70);
            doc.text(stmt.title, 20, y);
            y += 6;
            doc.setFont(undefined, 'normal');
            doc.setTextColor(40, 40, 40);
            const lines = doc.splitTextToSize(stmt.body, pageWidth - 40);
            doc.text(lines, 20, y);
            y += lines.length * 5 + 5;
        }

        y += 5;

        // Signature Section
        y = 240;
        doc.setDrawColor(100, 100, 100);
        doc.line(20, y, 90, y);
        doc.line(120, y, 190, y);
        
        doc.setFontSize(9);
        doc.text('Quality Manager', 20, y + 5);
        doc.text('Date', 60, y + 5);
        
        doc.text('Compliance Officer', 120, y + 5);
        doc.text('Date', 160, y + 5);

        // Footer
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text('Package Manufacturing Compliance System', pageWidth / 2, 280, { align: 'center' });
        doc.text(`Generated on ${new Date().toLocaleString()}`, pageWidth / 2, 285, { align: 'center' });

        const pdfBytes = doc.output('arraybuffer');

        return new Response(pdfBytes, {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename=Certificate_${batch.batch_number}.pdf`
            }
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});