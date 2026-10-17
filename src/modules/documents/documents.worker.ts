import type { Logger } from 'pino';
import type { StoragePort } from '../../infra/storage';
import type { DocumentRenderJob } from '../../infra/queues';
import { renderSnapshotToPdf, type DocumentsService } from './documents.service';

/**
 * Renders a frozen snapshot into a signed PDF and stores it.
 * Idempotent: re-delivery of the same job is a no-op once the document is READY.
 */
export class DocumentRenderWorker {
  constructor(
    private readonly documents: DocumentsService,
    private readonly storage: StoragePort,
    private readonly logger?: Logger,
  ) {}

  async render(job: DocumentRenderJob): Promise<void> {
    const documentId = job.documentId;
    const document = await this.documents.loadForRender(documentId);
    if (!document) {
      this.logger?.debug({ documentId }, 'document render skipped (already ready or terminal)');
      return;
    }

    await this.documents.markProcessing(documentId);
    try {
      const rendered = await renderSnapshotToPdf(document);
      const key = `documents/${document.studentId}/${document.id}.pdf`;
      await this.storage.putObject({ key, body: rendered.body, contentType: rendered.contentType });
      await this.documents.markReady(documentId, {
        storageKey: key,
        fileSize: rendered.body.byteLength,
        pageCount: rendered.pageCount,
      });
      this.logger?.info({ documentId, key, pageCount: rendered.pageCount }, 'document rendered');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.documents.markFailed(documentId, reason);
      this.logger?.error({ documentId, err: reason }, 'document render failed');
      throw error;
    }
  }
}
