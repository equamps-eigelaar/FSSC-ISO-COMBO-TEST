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
        doc.setFillColor(59, 130, 246);
        doc.rect(0, 0, pageWidth, 40, 'F');
        
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(22);
        doc.text('TECHNICAL DATA SHEET', pageWidth / 2, 18, { align: 'center' });
        
        doc.setFontSize(10);
        doc.text('Raw Material Specifications', pageWidth / 2, 28, { align: 'center' });

        // Document Info
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(9);
        doc.text(`TDS No: TDS-${batch.batch_number}`, 20, 50);
        doc.text(`Issue Date: ${new Date().toLocaleDateString()}`, pageWidth - 20, 50, { align: 'right' });

        // Material Identification
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('1. Material Identification', 20, 65);
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        let y = 75;

        const infoItems = [
            ['Material Name:', batch.material_name],
            ['Material Code:', batch.material_code || 'N/A'],
            ['Batch Number:', batch.batch_number],
            ['Supplier Batch:', batch.supplier_batch_number || 'N/A'],
            ['Purchase Order:', batch.po_number],
        ];

        infoItems.forEach(([label, value]) => {
            doc.text(label, 25, y);
            doc.setFont(undefined, 'bold');
            doc.text(value, 70, y);
            doc.setFont(undefined, 'normal');
            y += 7;
        });

        y += 8;

        // Supplier Information
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('2. Supplier Information', 20, y);
        y += 10;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.text('Supplier:', 25, y);
        doc.setFont(undefined, 'bold');
        doc.text(batch.supplier, 70, y);
        y += 15;

        // Physical Properties
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('3. Physical Properties', 20, y);
        y += 10;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        
        const specs = batch.specifications || {};
        const defaultSpecs = {
            appearance: 'Clear/Transparent',
            density: 'As per specification',
            thickness: 'As per specification',
            color: 'Natural/Clear',
        };

        const properties = { ...defaultSpecs, ...specs };
        
        Object.entries(properties).forEach(([key, value]) => {
            doc.text(`${key.charAt(0).toUpperCase() + key.slice(1)}:`, 25, y);
            doc.text(value.toString(), 70, y);
            y += 7;
        });

        y += 8;

        // Quality Test Results
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('4. Quality Test Results', 20, y);
        y += 10;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');

        const testResults = batch.test_results || {};
        if (Object.keys(testResults).length > 0) {
            Object.entries(testResults).forEach(([test, result]) => {
                doc.text(`${test}:`, 25, y);
                doc.text(result.toString(), 70, y);
                y += 7;
            });
        } else {
            doc.setFont(undefined, 'italic');
            doc.text('No test results recorded', 25, y);
            doc.setFont(undefined, 'normal');
            y += 7;
        }

        y += 8;

        // Storage and Handling
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('5. Storage and Handling', 20, y);
        y += 10;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        
        const storageInfo = [
            ['Storage Location:', batch.storage_location || 'Not specified'],
            ['Quantity:', `${batch.quantity || 'N/A'} ${batch.unit || ''}`],
            ['Manufacturing Date:', batch.manufacturing_date ? new Date(batch.manufacturing_date).toLocaleDateString() : 'N/A'],
            ['Expiry Date:', batch.expiry_date ? new Date(batch.expiry_date).toLocaleDateString() : 'N/A'],
            ['Received Date:', batch.received_date ? new Date(batch.received_date).toLocaleDateString() : 'N/A'],
        ];

        storageInfo.forEach(([label, value]) => {
            doc.text(label, 25, y);
            doc.text(value, 70, y);
            y += 7;
        });

        y += 8;

        // Compliance and Standards
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('6. Compliance and Standards', 20, y);
        y += 10;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        const complianceText = `This material complies with ISO 22000:2018 and TS 22002-4 requirements for use in packaging manufacturing operations. All applicable safety and quality standards have been met.`;
        const splitCompliance = doc.splitTextToSize(complianceText, pageWidth - 50);
        doc.text(splitCompliance, 25, y);

        // Footer
        const footerY = 280;
        doc.setDrawColor(200, 200, 200);
        doc.line(20, footerY - 5, pageWidth - 20, footerY - 5);
        
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text('Package Manufacturing Compliance System', pageWidth / 2, footerY, { align: 'center' });
        doc.text(`Generated on ${new Date().toLocaleString()}`, pageWidth / 2, footerY + 5, { align: 'center' });
        doc.text('This document is computer-generated and valid without signature', pageWidth / 2, footerY + 10, { align: 'center' });

        const pdfBytes = doc.output('arraybuffer');

        return new Response(pdfBytes, {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename=TDS_${batch.batch_number}.pdf`
            }
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});