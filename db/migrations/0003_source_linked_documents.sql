-- PDFs linked from an ingested web page, offered to admins as candidate sources.
ALTER TABLE knowledge_sources ADD COLUMN linked_documents jsonb NOT NULL DEFAULT '[]';
