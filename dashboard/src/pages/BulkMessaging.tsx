import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, FileText, Loader2, PauseCircle, PlayCircle, Upload, X, XCircle } from 'lucide-react';
import {
  messageApi,
  type BatchMessageResult,
  type BatchStatus,
  type BatchStatusResponse,
  type BulkMediaPayload,
  type BulkMessageItem,
  type MessageTemplate,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { useSessionsQuery, useTemplatesQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import {
  BULK_CAMPAIGN_MAX_BATCH_SIZE,
  BULK_CAMPAIGN_MIN_BATCH_SIZE,
  chunkBulkRecipients,
  clampBulkCampaignBatchSize,
  parseBulkRecipients,
} from '../utils/bulkRecipients';
import './BulkMessaging.css';

type BulkCampaignMessageType = 'text' | 'image' | 'video' | 'audio' | 'document';
type MessageSource = 'custom' | 'template';
type CampaignStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed';

interface MediaFileState {
  base64: string;
  mimetype: string;
  filename: string;
}

interface CampaignSnapshot {
  sessionId: string;
  chunks: string[][];
  type: BulkCampaignMessageType;
  text: string;
  media?: BulkMediaPayload;
  caption?: string;
}

const messageTypes: BulkCampaignMessageType[] = ['text', 'image', 'video', 'audio', 'document'];
const mediaMessageTypes: BulkCampaignMessageType[] = ['image', 'video', 'audio', 'document'];
const TERMINAL_BATCH_STATUSES: readonly BatchStatus[] = ['completed', 'cancelled', 'failed'];
const MEDIA_UPLOAD_MAX_BYTES = 18 * 1024 * 1024;

const mediaAccept: Record<BulkCampaignMessageType, string> = {
  text: '*/*',
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  document: '*/*',
};

const fallbackMime: Record<BulkCampaignMessageType, string> = {
  text: 'text/plain',
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  document: 'application/octet-stream',
};

function extractPlaceholders(template: MessageTemplate | null): string[] {
  if (!template) return [];
  const source = [template.header, template.body, template.footer].filter(Boolean).join('\n');
  return Array.from(new Set(Array.from(source.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g), match => match[1]))).sort();
}

function renderTemplate(template: MessageTemplate | null, values: Record<string, string>): string {
  if (!template) return '';
  return [template.header, template.body, template.footer]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => values[key] || `{{${key}}}`);
}

function emptyBatchStatus(batchId: string, total: number): BatchStatusResponse {
  return {
    batchId,
    status: 'pending',
    progress: { total, sent: 0, failed: 0, pending: total, cancelled: 0 },
    results: [],
  };
}

function buildMessage(
  chatId: string,
  snapshot: Pick<CampaignSnapshot, 'type' | 'text' | 'media' | 'caption'>,
): BulkMessageItem {
  if (snapshot.type === 'text') {
    return { chatId, type: 'text', content: { text: snapshot.text } };
  }

  const media = snapshot.media || {};
  return {
    chatId,
    type: snapshot.type,
    content: {
      [snapshot.type]: media,
      ...(snapshot.caption ? { caption: snapshot.caption } : {}),
    },
  } as BulkMessageItem;
}

export function BulkMessaging() {
  const { t } = useTranslation();
  useDocumentTitle(t('bulkMessaging.title'));
  const { canWrite } = useRole();
  const toast = useToast();
  const { data: allSessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const sessions = allSessions.filter(session => session.status === 'ready');

  const [sessionId, setSessionId] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [batchSizeInput, setBatchSizeInput] = useState('10');
  const [messageType, setMessageType] = useState<BulkCampaignMessageType>('text');
  const [messageSource, setMessageSource] = useState<MessageSource>('custom');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaFile, setMediaFile] = useState<MediaFileState | null>(null);
  const [caption, setCaption] = useState('');
  const [documentFilename, setDocumentFilename] = useState('');
  const [campaignStatus, setCampaignStatus] = useState<CampaignStatus>('idle');
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [activeBatchIndex, setActiveBatchIndex] = useState(-1);
  const [batchStatuses, setBatchStatuses] = useState<BatchStatusResponse[]>([]);
  const [campaignChunks, setCampaignChunks] = useState<string[][]>([]);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaReadSeq = useRef(0);
  const campaignSeq = useRef(0);
  const stopRequestedRef = useRef(false);
  const activeBatchRef = useRef<{ sessionId: string; batchId: string } | null>(null);

  const { data: templates = [], isLoading: loadingTemplates } = useTemplatesQuery(sessionId, !!sessionId);
  const selectedTemplate = templates.find(template => template.id === selectedTemplateId) ?? null;
  const templatePlaceholders = useMemo(() => extractPlaceholders(selectedTemplate), [selectedTemplate]);
  const renderedTemplate = useMemo(() => renderTemplate(selectedTemplate, templateValues), [selectedTemplate, templateValues]);
  const recipients = useMemo(() => parseBulkRecipients(recipientsText), [recipientsText]);
  const batchSize = clampBulkCampaignBatchSize(parseInt(batchSizeInput, 10));
  const plannedChunks = useMemo(() => chunkBulkRecipients(recipients, batchSize), [recipients, batchSize]);
  const isMediaMessageType = mediaMessageTypes.includes(messageType);
  const textToSend = messageSource === 'template' ? renderedTemplate : customText.trim();
  const hasMedia = !!mediaFile || mediaUrl.trim().length > 0;
  const isCampaignActive = campaignStatus === 'running' || campaignStatus === 'stopping';

  useEffect(() => {
    if (sessions.length > 0 && !sessionId) setSessionId(sessions[0].id);
  }, [sessions, sessionId]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) setSelectedTemplateId(templates[0].id);
    if (selectedTemplateId && !templates.some(template => template.id === selectedTemplateId)) setSelectedTemplateId('');
  }, [selectedTemplateId, templates]);

  useEffect(() => {
    setTemplateValues(current => {
      const next: Record<string, string> = {};
      for (const key of templatePlaceholders) next[key] = current[key] || '';
      return next;
    });
  }, [templatePlaceholders]);

  useEffect(() => {
    return () => {
      campaignSeq.current += 1;
      stopRequestedRef.current = true;
      mediaReadSeq.current += 1;
    };
  }, []);

  const updateBatchStatus = (index: number, status: BatchStatusResponse) => {
    setBatchStatuses(current => {
      const next = [...current];
      next[index] = status;
      return next;
    });
  };

  const clearMediaFile = () => {
    mediaReadSeq.current += 1;
    setMediaFile(null);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MEDIA_UPLOAD_MAX_BYTES) {
      toast.error(t('bulkMessaging.toasts.fileTooLarge'));
      return;
    }

    const readId = ++mediaReadSeq.current;
    const reader = new FileReader();
    reader.onload = () => {
      if (mediaReadSeq.current !== readId) return;
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      const base64 = dataUrl.split(',')[1] ?? '';
      if (!base64) return;
      setMediaFile({ base64, mimetype: file.type || fallbackMime[messageType], filename: file.name });
      setMediaUrl('');
      if (messageType === 'document') setDocumentFilename(file.name);
    };
    reader.onerror = () => {
      if (mediaReadSeq.current === readId) toast.error(t('bulkMessaging.toasts.fileReadFailed'));
    };
    reader.readAsDataURL(file);
  };

  const waitForTerminalBatch = async (snapshot: CampaignSnapshot, batchId: string, index: number, token: number) => {
    while (campaignSeq.current === token && !stopRequestedRef.current) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (campaignSeq.current !== token || stopRequestedRef.current) return null;
      const status = await messageApi.getBatchStatus(snapshot.sessionId, batchId);
      updateBatchStatus(index, status);
      if (TERMINAL_BATCH_STATUSES.includes(status.status)) return status;
    }
    return null;
  };

  const runCampaign = async (snapshot: CampaignSnapshot, token: number) => {
    for (let index = 0; index < snapshot.chunks.length; index += 1) {
      if (campaignSeq.current !== token || stopRequestedRef.current) return;
      setActiveBatchIndex(index);

      const batch = await messageApi.sendBulk(snapshot.sessionId, {
        messages: snapshot.chunks[index].map(chatId => buildMessage(chatId, snapshot)),
      });

      if (campaignSeq.current !== token || stopRequestedRef.current) return;
      activeBatchRef.current = { sessionId: snapshot.sessionId, batchId: batch.batchId };
      updateBatchStatus(index, emptyBatchStatus(batch.batchId, batch.totalMessages));

      const terminal = await waitForTerminalBatch(snapshot, batch.batchId, index, token);
      activeBatchRef.current = null;
      if (!terminal) return;
      if (terminal.status === 'cancelled') {
        setCampaignStatus('cancelled');
        setCompletedAt(new Date().toISOString());
        return;
      }
    }

    if (campaignSeq.current !== token) return;
    setCampaignStatus('completed');
    setActiveBatchIndex(-1);
    setCompletedAt(new Date().toISOString());
    toast.success(t('bulkMessaging.toasts.completed'));
  };

  const startCampaign = () => {
    const chunks = plannedChunks;
    if (!sessionId || chunks.length === 0) return;

    const media: BulkMediaPayload | undefined = isMediaMessageType
      ? mediaFile
        ? {
            base64: mediaFile.base64,
            mimetype: mediaFile.mimetype,
            ...(messageType === 'document' && documentFilename.trim() ? { filename: documentFilename.trim() } : {}),
          }
        : { url: mediaUrl.trim() }
      : undefined;

    const snapshot: CampaignSnapshot = {
      sessionId,
      chunks,
      type: messageType,
      text: textToSend,
      media,
      caption: messageType === 'audio' ? undefined : caption.trim() || undefined,
    };

    const token = ++campaignSeq.current;
    stopRequestedRef.current = false;
    activeBatchRef.current = null;
    setCampaignStatus('running');
    setStartedAt(new Date().toISOString());
    setCompletedAt(null);
    setCampaignError(null);
    setCampaignChunks(chunks);
    setBatchStatuses([]);
    setActiveBatchIndex(0);

    void runCampaign(snapshot, token).catch(error => {
      if (campaignSeq.current !== token) return;
      const message = error instanceof Error ? error.message : t('common.unknownError');
      setCampaignStatus('failed');
      setCampaignError(message);
      setCompletedAt(new Date().toISOString());
      activeBatchRef.current = null;
      toast.error(t('bulkMessaging.toasts.failed', { message }));
    });
  };

  const stopCampaign = async () => {
    if (!isCampaignActive) return;
    stopRequestedRef.current = true;
    setCampaignStatus('stopping');
    const activeBatch = activeBatchRef.current;
    if (!activeBatch) {
      setCampaignStatus('cancelled');
      setCompletedAt(new Date().toISOString());
      return;
    }

    try {
      const status = await messageApi.cancelBatch(activeBatch.sessionId, activeBatch.batchId);
      setBatchStatuses(current =>
        current.map(batch => (batch?.batchId === activeBatch.batchId ? { ...batch, ...status, results: batch.results } : batch)),
      );
      setCampaignStatus('cancelled');
      toast.success(t('bulkMessaging.toasts.cancelled'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('common.unknownError');
      setCampaignStatus('failed');
      setCampaignError(message);
      toast.error(t('bulkMessaging.toasts.cancelFailed', { message }));
    } finally {
      setCompletedAt(new Date().toISOString());
      activeBatchRef.current = null;
    }
  };

  const progress = useMemo(() => {
    const total = campaignChunks.length > 0 ? campaignChunks.reduce((sum, chunk) => sum + chunk.length, 0) : recipients.length;
    const sent = batchStatuses.reduce((sum, batch) => sum + (batch?.progress.sent ?? 0), 0);
    const failed = batchStatuses.reduce((sum, batch) => sum + (batch?.progress.failed ?? 0), 0);
    const cancelled = batchStatuses.reduce((sum, batch) => sum + (batch?.progress.cancelled ?? 0), 0);
    const attempted = sent + failed + cancelled;
    return {
      total,
      sent,
      failed,
      cancelled,
      pending: Math.max(0, total - attempted),
      percent: total > 0 ? Math.round((attempted / total) * 100) : 0,
    };
  }, [batchStatuses, campaignChunks, recipients.length]);

  const recentResults: BatchMessageResult[] = batchStatuses.flatMap(batch => batch?.results ?? []).slice(-8).reverse();
  const activeBatch = activeBatchIndex >= 0 ? batchStatuses[activeBatchIndex] : null;
  const canStart =
    canWrite &&
    !isCampaignActive &&
    !!sessionId &&
    recipients.length > 0 &&
    ((messageType === 'text' && textToSend.length > 0) || (isMediaMessageType && hasMedia));

  if (loadingSessions) {
    return (
      <div className="bulk-messaging-page bulk-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="bulk-messaging-page">
      <PageHeader title={t('bulkMessaging.title')} subtitle={t('bulkMessaging.subtitle')} />

      <div className="bulk-workspace">
        <section className="bulk-compose-panel">
          <div className="panel-heading">
            <h2>{t('bulkMessaging.composeTitle')}</h2>
          </div>

          <div className="form-grid">
            <label htmlFor="bulk-session">
              <span>{t('bulkMessaging.session')}</span>
              <select
                id="bulk-session"
                value={sessionId}
                onChange={event => setSessionId(event.target.value)}
                disabled={isCampaignActive}
              >
                {sessions.length === 0 && <option value="">{t('bulkMessaging.noReadySessions')}</option>}
                {sessions.map(session => (
                  <option key={session.id} value={session.id}>
                    {session.name} ({session.phone || t('messageTester.sessionOptionPhoneNone')})
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="bulk-batch-size">
              <span>{t('bulkMessaging.batchSize')}</span>
              <input
                id="bulk-batch-size"
                type="number"
                min={BULK_CAMPAIGN_MIN_BATCH_SIZE}
                max={BULK_CAMPAIGN_MAX_BATCH_SIZE}
                value={batchSizeInput}
                onBlur={() => setBatchSizeInput(String(batchSize))}
                onChange={event => setBatchSizeInput(event.target.value)}
                disabled={isCampaignActive}
              />
            </label>
          </div>

          <label className="field-block" htmlFor="bulk-recipients">
            <span>{t('bulkMessaging.recipients')}</span>
            <textarea
              id="bulk-recipients"
              value={recipientsText}
              onChange={event => setRecipientsText(event.target.value)}
              placeholder={t('bulkMessaging.recipientsPlaceholder')}
              rows={8}
              disabled={isCampaignActive}
            />
          </label>
          <div className="bulk-hint">
            {t('bulkMessaging.recipientsHint', { count: recipients.length, batches: plannedChunks.length })}
          </div>

          <div className="field-block">
            <span>{t('bulkMessaging.messageType')}</span>
            <div className="bulk-type-grid" role="group" aria-label={t('bulkMessaging.messageType')}>
              {messageTypes.map(type => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={messageType === type}
                  className={messageType === type ? 'active' : ''}
                  onClick={() => {
                    if (type !== messageType) clearMediaFile();
                    setMessageType(type);
                    if (type !== 'text') setMessageSource('custom');
                  }}
                  disabled={isCampaignActive}
                >
                  {t(`bulkMessaging.types.${type}`)}
                </button>
              ))}
            </div>
          </div>

          {messageType === 'text' && (
            <div className="field-block">
              <span>{t('bulkMessaging.messageSource')}</span>
              <div className="bulk-source-row" role="group" aria-label={t('bulkMessaging.messageSource')}>
                <button
                  type="button"
                  aria-pressed={messageSource === 'custom'}
                  className={messageSource === 'custom' ? 'active' : ''}
                  onClick={() => setMessageSource('custom')}
                  disabled={isCampaignActive}
                >
                  {t('bulkMessaging.customMessage')}
                </button>
                <button
                  type="button"
                  aria-pressed={messageSource === 'template'}
                  className={messageSource === 'template' ? 'active' : ''}
                  onClick={() => setMessageSource('template')}
                  disabled={isCampaignActive || templates.length === 0}
                >
                  {t('bulkMessaging.savedTemplate')}
                </button>
              </div>
            </div>
          )}

          {messageType === 'text' && messageSource === 'template' ? (
            <div className="template-compose">
              <label htmlFor="bulk-template">
                <span>{t('bulkMessaging.template')}</span>
                <select
                  id="bulk-template"
                  value={selectedTemplateId}
                  onChange={event => setSelectedTemplateId(event.target.value)}
                  disabled={isCampaignActive || loadingTemplates}
                >
                  {templates.length === 0 && <option value="">{t('bulkMessaging.noTemplates')}</option>}
                  {templates.map(template => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              {templatePlaceholders.length > 0 && (
                <div className="template-variable-grid">
                  {templatePlaceholders.map(key => (
                    <label key={key} htmlFor={`bulk-var-${key}`}>
                      <span>{`{{${key}}}`}</span>
                      <input
                        id={`bulk-var-${key}`}
                        value={templateValues[key] || ''}
                        onChange={event => setTemplateValues({ ...templateValues, [key]: event.target.value })}
                        disabled={isCampaignActive}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="message-preview">
                <pre>{renderedTemplate || t('bulkMessaging.previewEmpty')}</pre>
              </div>
            </div>
          ) : messageType === 'text' ? (
            <label className="field-block" htmlFor="bulk-message-content">
              <span>{t('bulkMessaging.messageContent')}</span>
              <textarea
                id="bulk-message-content"
                value={customText}
                onChange={event => setCustomText(event.target.value)}
                placeholder={t('bulkMessaging.messagePlaceholder')}
                rows={7}
                disabled={isCampaignActive}
              />
            </label>
          ) : (
            <div className="media-compose">
              <label htmlFor="bulk-media-url">
                <span>{t('bulkMessaging.mediaUrl')}</span>
                <input
                  id="bulk-media-url"
                  value={mediaUrl}
                  onChange={event => {
                    setMediaUrl(event.target.value);
                    if (mediaFile) clearMediaFile();
                  }}
                  placeholder="https://example.com/file"
                  disabled={isCampaignActive || !!mediaFile}
                />
              </label>
              <div className="media-upload-row">
                {mediaFile ? (
                  <div className="file-selected">
                    <FileText size={16} />
                    <span title={mediaFile.filename}>{mediaFile.filename}</span>
                    <button type="button" className="icon-action" onClick={clearMediaFile} disabled={isCampaignActive}>
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isCampaignActive}
                  >
                    <Upload size={16} />
                    {t('bulkMessaging.browse')}
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  aria-label={t('bulkMessaging.uploadFile')}
                  type="file"
                  accept={mediaAccept[messageType]}
                  onChange={handleFileChange}
                  hidden
                />
              </div>
              {messageType !== 'audio' && (
                <label htmlFor="bulk-caption">
                  <span>{t('bulkMessaging.caption')}</span>
                  <input
                    id="bulk-caption"
                    value={caption}
                    onChange={event => setCaption(event.target.value)}
                    disabled={isCampaignActive}
                    placeholder={t('bulkMessaging.captionPlaceholder')}
                  />
                </label>
              )}
              {messageType === 'document' && (
                <label htmlFor="bulk-filename">
                  <span>{t('bulkMessaging.filename')}</span>
                  <input
                    id="bulk-filename"
                    value={documentFilename}
                    onChange={event => setDocumentFilename(event.target.value)}
                    disabled={isCampaignActive}
                    placeholder="document.pdf"
                  />
                </label>
              )}
            </div>
          )}

          <div className="campaign-actions">
            <button type="button" className="btn-primary" onClick={startCampaign} disabled={!canStart}>
              {campaignStatus === 'running' ? <Loader2 size={18} className="animate-spin" /> : <PlayCircle size={18} />}
              {canWrite ? t('bulkMessaging.startCampaign') : t('bulkMessaging.viewOnly')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => void stopCampaign()} disabled={!isCampaignActive}>
              <PauseCircle size={18} />
              {campaignStatus === 'stopping' ? t('bulkMessaging.stopping') : t('bulkMessaging.stopCampaign')}
            </button>
          </div>
        </section>

        <aside className="bulk-progress-panel">
          <div className="panel-heading">
            <h2>{t('bulkMessaging.progressTitle')}</h2>
            <span className={`campaign-badge ${campaignStatus}`}>{t(`bulkMessaging.status.${campaignStatus}`)}</span>
          </div>

          <div className="progress-meter" aria-label={t('bulkMessaging.progressTitle')}>
            <div className="progress-meter-fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="progress-line">{t('bulkMessaging.percentComplete', { percent: progress.percent })}</div>

          <div className="metric-grid">
            <div>
              <span>{t('bulkMessaging.metrics.total')}</span>
              <strong>{progress.total}</strong>
            </div>
            <div>
              <span>{t('bulkMessaging.metrics.sent')}</span>
              <strong>{progress.sent}</strong>
            </div>
            <div>
              <span>{t('bulkMessaging.metrics.failed')}</span>
              <strong>{progress.failed}</strong>
            </div>
            <div>
              <span>{t('bulkMessaging.metrics.pending')}</span>
              <strong>{progress.pending}</strong>
            </div>
            <div>
              <span>{t('bulkMessaging.metrics.cancelled')}</span>
              <strong>{progress.cancelled}</strong>
            </div>
            <div>
              <span>{t('bulkMessaging.metrics.batches')}</span>
              <strong>{campaignChunks.length || plannedChunks.length}</strong>
            </div>
          </div>

          <div className="batch-details">
            <div>
              <span>{t('bulkMessaging.activeBatch')}</span>
              <strong>
                {activeBatchIndex >= 0
                  ? t('bulkMessaging.batchOf', {
                      current: activeBatchIndex + 1,
                      total: campaignChunks.length || plannedChunks.length,
                    })
                  : t('bulkMessaging.none')}
              </strong>
            </div>
            <div>
              <span>{t('bulkMessaging.batchId')}</span>
              <code>{activeBatch?.batchId || t('bulkMessaging.none')}</code>
            </div>
            <div>
              <span>{t('bulkMessaging.startedAt')}</span>
              <strong>{startedAt || t('bulkMessaging.none')}</strong>
            </div>
            <div>
              <span>{t('bulkMessaging.completedAt')}</span>
              <strong>{completedAt || t('bulkMessaging.none')}</strong>
            </div>
          </div>

          {campaignError && (
            <div className="campaign-error">
              <XCircle size={18} />
              <span>{campaignError}</span>
            </div>
          )}

          <div className="result-list">
            <h3>{t('bulkMessaging.recentResults')}</h3>
            {recentResults.length === 0 ? (
              <p>{t('bulkMessaging.noResults')}</p>
            ) : (
              recentResults.map((result, index) => (
                <div className="result-row" key={`${result.chatId}-${result.sentAt || index}`}>
                  {result.status === 'sent' ? <CheckCircle size={16} /> : <XCircle size={16} />}
                  <span>{result.chatId}</span>
                  <strong>{t(`bulkMessaging.resultStatus.${result.status}`)}</strong>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
