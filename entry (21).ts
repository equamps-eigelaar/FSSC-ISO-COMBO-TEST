import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { document_id, question } = await req.json();

    if (!document_id || !question) {
      return Response.json({ error: 'document_id and question required' }, { status: 400 });
    }

    const documents = await base44.entities.Document.filter({ id: document_id });
    const document = documents[0];

    if (!document) {
      return Response.json({ error: 'Document not found' }, { status: 404 });
    }

    const prompt = `You are a compliance document assistant. The user is viewing the following document:

File Name: ${document.file_name}
Document Type: ${document.document_type?.replace(/_/g, ' ')}
${document.description ? `Description: ${document.description}` : ''}

The user asks: "${question}"

Answer the question based on the document content. Be concise, accurate, and helpful. If you cannot find the answer in the document, say so clearly. Format your response in clear plain text (no markdown headers, just paragraphs or short bullet points if needed).`;

    const answer = await base44.integrations.Core.InvokeLLM({
      prompt,
      file_urls: [document.file_url],
    });

    return Response.json({ answer });

  } catch (error) {
    console.error('askDocumentQuestion error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});