import { useState, useEffect, useCallback, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Plus, QrCode, RefreshCw, Trash2, Eye, Loader2, Play, Square, X, Search, Filter } from 'lucide-react';
import { sessionApi, type Session } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../components/Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import './Sessions.css';

export function Sessions() {
  const { t } = useTranslation();
  useDocumentTitle(t('sessions.title'));
  const toast = useToast();
  const { canWrite } = useRole();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [qrData, setQrData] = useState<{ sessionId: string; sessionName: string; qrCode: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'details' | 'groups'>('details');
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [showCreateGroupForm, setShowCreateGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupParticipants, setNewGroupParticipants] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [leavingGroupId, setLeavingGroupId] = useState<string | null>(null);

  useWebSocket({
    onSessionStatus: useCallback(
      (event: { sessionId: string; status: string }) => {
        setSessions(prev =>
          prev.map(s => (s.id === event.sessionId ? { ...s, status: event.status as Session['status'] } : s)),
        );
        if (event.status === 'ready') {
          toast.success(t('sessions.toasts.readyTitle'), t('sessions.toasts.readyDesc'));
        } else if (event.status === 'disconnected') {
          toast.warning(t('sessions.toasts.disconnectedTitle'), t('sessions.toasts.disconnectedDesc'));
        }
      },
      [toast, t],
    ),
  });

  const fetchSessions = async () => {
    try {
      setLoading(true);
      const data = await sessionApi.list();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.create.errorDefault'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const qrRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentSessionName = useRef<string>('');

  const fetchQR = useCallback(async (sessionId: string) => {
    try {
      const qr = await sessionApi.getQR(sessionId);
      setQrData({ sessionId, sessionName: currentSessionName.current, qrCode: qr.qrCode });
      if (qr.status === 'ready') {
        setQrData(null);
        currentSessionName.current = '';
        fetchSessions();
      }
    } catch {
      setQrData(null);
      currentSessionName.current = '';
      fetchSessions();
    }
  }, []);

  useEffect(() => {
    if (qrData) {
      currentSessionName.current = qrData.sessionName;
      qrRefreshInterval.current = setInterval(() => {
        fetchQR(qrData.sessionId);
      }, 5000);
    }
    return () => {
      if (qrRefreshInterval.current) clearInterval(qrRefreshInterval.current);
    };
  }, [qrData, fetchQR]);

  const handleCreate = async () => {
    if (!newSessionName.trim()) return;
    try {
      setCreating(true);
      const newSession = await sessionApi.create(newSessionName);
      setSessions([...sessions, newSession]);
      setNewSessionName('');
      setShowCreateModal(false);
      toast.success(t('sessions.create.successTitle'), t('sessions.create.successDesc', { name: newSession.name }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.create.errorDefault');
      setError(msg);
      toast.error(t('sessions.create.errorTitle'), msg);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    try {
      await sessionApi.delete(id);
      setSessions(sessions.filter(s => s.id !== id));
      toast.success(
        t('sessions.delete.successTitle'),
        session ? t('sessions.delete.successDescNamed', { name: session.name }) : t('sessions.delete.successDescGeneric'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.delete.errorDefault');
      console.error('Failed to delete:', err);
      toast.error(t('sessions.delete.errorTitle'), msg);
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleStart = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session && ['initializing', 'connecting', 'qr_ready'].includes(session.status)) {
      handleShowQR(id);
      return;
    }

    try {
      await sessionApi.start(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'connecting' } : s)));
      await fetchSessions();
      handleShowQR(id);
    } catch (err) {
      console.error('Failed to start:', err);
      await fetchSessions();
      if (err instanceof Error && err.message.includes('already started')) {
        handleShowQR(id);
      }
    }
  };

  const handleShowQR = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    const sessionName = session?.name || '';
    try {
      const qr = await sessionApi.getQR(id);
      setQrData({ sessionId: id, sessionName, qrCode: qr.qrCode });
    } catch (err) {
      console.error('Failed to get QR:', err);
      setError(t('sessions.qr.unavailable'));
    }
  };

  const handleStop = async (id: string) => {
    try {
      await sessionApi.stop(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'disconnected' } : s)));
      if (qrData?.sessionId === id) setQrData(null);
    } catch (err) {
      console.error('Failed to stop:', err);
      fetchSessions();
    }
  };

  const formatLastActive = (date?: string) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  const fetchGroups = useCallback(async (sessionId: string) => {
    try {
      setLoadingGroups(true);
      const data = await sessionApi.getGroups(sessionId);
      setGroups(data);
    } catch (err) {
      console.error('Failed to fetch groups:', err);
      toast.error(t('sessions.groups.fetchError', 'Failed to fetch groups'), err instanceof Error ? err.message : '');
    } finally {
      setLoadingGroups(false);
    }
  }, [toast, t]);

  useEffect(() => {
    if (selectedSession && activeTab === 'groups') {
      fetchGroups(selectedSession.id);
    }
  }, [selectedSession?.id, activeTab]);

  useEffect(() => {
    if (!selectedSession) {
      setActiveTab('details');
      setGroups([]);
      setShowCreateGroupForm(false);
      setNewGroupName('');
      setNewGroupParticipants('');
    }
  }, [selectedSession]);

  const handleCreateGroup = async () => {
    if (!selectedSession || !newGroupName.trim()) return;

    const participantList = newGroupParticipants
      .split(',')
      .map(p => {
        let clean = p.trim().replace(/[\s\-()]/g, '');
        if (clean.startsWith('+')) {
          clean = clean.substring(1);
        }
        return clean;
      })
      .filter(p => p.length > 0);

    if (participantList.length === 0) {
      toast.warning(t('sessions.groups.noParticipants', 'No participants'), t('sessions.groups.noParticipantsDesc', 'Please enter at least one participant phone number'));
      return;
    }

    try {
      setCreatingGroup(true);
      await sessionApi.createGroup(selectedSession.id, newGroupName.trim(), participantList);
      toast.success(t('sessions.groups.createSuccess', 'Group Created'), t('sessions.groups.createSuccessDesc', { name: newGroupName.trim() }));
      setNewGroupName('');
      setNewGroupParticipants('');
      setShowCreateGroupForm(false);
      fetchGroups(selectedSession.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.groups.createError', 'Failed to create group');
      toast.error(t('sessions.groups.createErrorTitle', 'Error creating group'), msg);
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleLeaveGroup = async (groupId: string) => {
    if (!selectedSession) return;
    try {
      setLeavingGroupId(groupId);
      await sessionApi.leaveGroup(selectedSession.id, groupId);
      toast.success(t('sessions.groups.leaveSuccess', 'Left Group'), t('sessions.groups.leaveSuccessDesc', 'Successfully left the group'));
      fetchGroups(selectedSession.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.groups.leaveError', 'Failed to leave group');
      toast.error(t('sessions.groups.leaveErrorTitle', 'Error leaving group'), msg);
    } finally {
      setLeavingGroupId(null);
    }
  };

  const filteredSessions = sessions.filter(s => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && s.status === 'ready') ||
      (statusFilter === 'inactive' && ['created', 'idle', 'disconnected'].includes(s.status)) ||
      (statusFilter === 'connecting' && ['initializing', 'connecting', 'qr_ready'].includes(s.status));
    return matchesSearch && matchesStatus;
  });

  if (loading) {
    return (
      <div
        className="sessions-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="sessions-page">
      <PageHeader
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              {t('sessions.newSession')}
            </button>
          )
        }
      />

      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('sessions.searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">{t('sessions.filter.all')}</option>
            <option value="active">{t('sessions.filter.active')}</option>
            <option value="inactive">{t('sessions.filter.inactive')}</option>
            <option value="connecting">{t('sessions.filter.connecting')}</option>
          </select>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: '#FEE2E2',
            padding: '1rem',
            borderRadius: '8px',
            color: '#DC2626',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('sessions.create.title')}</h2>
              <button className="btn-icon" onClick={() => setShowCreateModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>{t('sessions.create.label')}</label>
              <input
                type="text"
                placeholder={t('sessions.create.placeholder')}
                value={newSessionName}
                onChange={e => {
                  const value = e.target.value.toLowerCase().replace(/\s+/g, '-');
                  setNewSessionName(value);
                }}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
              <p className="input-hint">
                <Trans i18nKey="sessions.create.hint" components={{ code: <code /> }} />
              </p>
              {newSessionName && !/^[a-z0-9-]+$/.test(newSessionName) && (
                <p className="input-error">{t('sessions.create.invalidChars')}</p>
              )}
              {newSessionName && newSessionName.length > 50 && (
                <p className="input-error">{t('sessions.create.tooLong', { length: newSessionName.length })}</p>
              )}
              {newSessionName &&
                /^[a-z0-9-]+$/.test(newSessionName) &&
                newSessionName.length <= 50 &&
                sessions.some(s => s.name === newSessionName) && (
                  <p className="input-error">{t('sessions.create.duplicate')}</p>
                )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={
                  creating ||
                  !newSessionName.trim() ||
                  !/^[a-z0-9-]+$/.test(newSessionName) ||
                  newSessionName.length > 50 ||
                  sessions.some(s => s.name === newSessionName)
                }
              >
                {creating ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {qrData && (
        <div className="modal-overlay" onClick={() => setQrData(null)}>
          <div className="modal qr-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h2>{t('sessions.qr.title')}</h2>
                <span className="session-name">{qrData.sessionName}</span>
              </div>
              <button className="btn-close" onClick={() => setQrData(null)} aria-label={t('common.close')}>
                <X size={20} color="#64748b" />
              </button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center' }}>
              {qrData.qrCode ? (
                <>
                  <img src={qrData.qrCode} alt="QR" style={{ maxWidth: '280px', borderRadius: '12px' }} />
                  <div className="qr-instructions">
                    <p className="qr-step"><Trans i18nKey="sessions.qr.step1" components={{ strong: <strong /> }} /></p>
                    <p className="qr-step"><Trans i18nKey="sessions.qr.step2" components={{ strong: <strong /> }} /></p>
                    <p className="qr-step"><Trans i18nKey="sessions.qr.step3" components={{ strong: <strong /> }} /></p>
                  </div>
                  <p className="qr-auto-refresh">
                    <RefreshCw size={14} className="spin-slow" /> {t('sessions.qr.autoRefresh')}
                  </p>
                </>
              ) : (
                <div style={{ padding: '2rem' }}>
                  <Loader2 className="animate-spin" size={48} />
                  <p>{t('sessions.qr.generating')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedSession && (
        <div className="modal-overlay" onClick={() => setSelectedSession(null)}>
          <div className="modal session-detail-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h2>{t('sessions.details.title')}</h2>
                <span className="session-name">{selectedSession.name}</span>
              </div>
              <button className="btn-icon" onClick={() => setSelectedSession(null)}>
                <X size={20} />
              </button>
            </div>

            {selectedSession.status === 'ready' && (
              <div className="modal-tabs">
                <button
                  className={`tab-btn ${activeTab === 'details' ? 'active' : ''}`}
                  onClick={() => setActiveTab('details')}
                >
                  {t('sessions.details.tabInfo', 'Info')}
                </button>
                <button
                  className={`tab-btn ${activeTab === 'groups' ? 'active' : ''}`}
                  onClick={() => setActiveTab('groups')}
                >
                  {t('sessions.details.tabGroups', 'Groups')}
                </button>
              </div>
            )}

            <div className="modal-body">
              {activeTab === 'details' || selectedSession.status !== 'ready' ? (
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">{t('sessions.details.name')}</span>
                    <span className="detail-value">{selectedSession.name}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">{t('sessions.details.status')}</span>
                    <span className={`status-badge ${selectedSession.status}`}>{formatStatus(selectedSession.status)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">{t('sessions.details.sessionId')}</span>
                    <span className="detail-value mono">{selectedSession.id}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">{t('sessions.details.phone')}</span>
                    <span className="detail-value">{selectedSession.phone || t('sessions.details.phoneNone')}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">{t('sessions.details.created')}</span>
                    <span className="detail-value">{new Date(selectedSession.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">{t('sessions.details.lastActive')}</span>
                    <span className="detail-value">
                      {selectedSession.lastActive ? new Date(selectedSession.lastActive).toLocaleString() : t('common.never')}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="groups-tab-content">
                  {showCreateGroupForm ? (
                    <div className="create-group-form">
                      <h3>{t('sessions.groups.createNew', 'Create New Group')}</h3>
                      <div className="form-field">
                        <label>{t('sessions.groups.fieldName', 'Group Name')}</label>
                        <input
                          type="text"
                          placeholder="e.g. My Whatsapp Group"
                          value={newGroupName}
                          onChange={e => setNewGroupName(e.target.value)}
                        />
                      </div>
                      <div className="form-field">
                        <label>{t('sessions.groups.fieldParticipants', 'Participants (Phone Numbers, comma-separated)')}</label>
                        <textarea
                          rows={3}
                          placeholder="e.g. 918010710484, 919326426019"
                          value={newGroupParticipants}
                          onChange={e => setNewGroupParticipants(e.target.value)}
                        />
                        <span className="field-hint">Include country prefix (e.g. 91 for India), no + or spaces.</span>
                      </div>
                      <div className="form-actions">
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => setShowCreateGroupForm(false)}
                          disabled={creatingGroup}
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          className="btn-primary btn-sm"
                          onClick={handleCreateGroup}
                          disabled={creatingGroup || !newGroupName.trim()}
                        >
                          {creatingGroup ? <Loader2 className="animate-spin" size={14} /> : t('common.create')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="groups-list-view">
                      <div className="groups-list-header">
                        <h3>{t('sessions.groups.activeGroups', 'Active Groups')}</h3>
                        <button className="btn-primary btn-sm" onClick={() => setShowCreateGroupForm(true)}>
                          <Plus size={14} />
                          {t('sessions.groups.create', 'Create Group')}
                        </button>
                      </div>

                      {loadingGroups ? (
                        <div className="groups-loading">
                          <Loader2 className="animate-spin" size={24} />
                          <p>{t('sessions.groups.loading', 'Loading groups...')}</p>
                        </div>
                      ) : groups.length === 0 ? (
                        <div className="groups-empty">
                          <p>{t('sessions.groups.noneFound', 'No groups found for this session.')}</p>
                        </div>
                      ) : (
                        <div className="groups-scroll-area">
                          {groups.map(group => (
                            <div key={group.id} className="group-list-item">
                              <div className="group-info">
                                <span className="group-name">{group.name}</span>
                                <span className="group-id mono">{group.id}</span>
                              </div>
                              <button
                                className="btn-danger btn-xs"
                                onClick={() => handleLeaveGroup(group.id)}
                                disabled={leavingGroupId === group.id}
                              >
                                {leavingGroupId === group.id ? <Loader2 className="animate-spin" size={12} /> : t('sessions.groups.leave', 'Leave')}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setSelectedSession(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmId && (
        <div className="modal-overlay" onClick={() => setDeleteConfirmId(null)}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('sessions.delete.title')}</h2>
              <button className="btn-icon" onClick={() => setDeleteConfirmId(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>
                <Trans
                  i18nKey="sessions.delete.message"
                  values={{ name: sessions.find(s => s.id === deleteConfirmId)?.name }}
                  components={{ strong: <strong /> }}
                />
              </p>
              <p className="text-muted">{t('sessions.delete.warning')}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteConfirmId(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => handleDelete(deleteConfirmId)}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="sessions-grid">
        {filteredSessions.length === 0 ? (
          <div className="empty-state">
            <QrCode size={48} />
            <h3>{t('sessions.empty.title')}</h3>
            <p>{t('sessions.empty.description')}</p>
          </div>
        ) : (
          filteredSessions.map(session => (
            <div key={session.id} className="session-card">
              <div className="card-header">
                <h3 title={session.name}>{session.name}</h3>
                <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
              </div>

              {session.status === 'initializing' || session.status === 'connecting' || session.status === 'qr_ready' ? (
                <div className="qr-placeholder">
                  <QrCode size={80} className="qr-icon" />
                  <p>{session.status === 'qr_ready' ? t('sessions.qr.scanToConnect') : t('sessions.qr.preparing')}</p>
                  <button
                    className="btn-sm"
                    onClick={() => handleShowQR(session.id)}
                    disabled={session.status !== 'qr_ready'}
                  >
                    {session.status === 'qr_ready' ? t('sessions.qr.showQr') : t('sessions.qr.loading')}
                  </button>
                </div>
              ) : (
                <div className="session-info">
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.phone')}</span>
                    <span className="info-value">{session.phone || '—'}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.sessionId')}</span>
                    <span className="info-value mono">{session.id.substring(0, 12)}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.lastActive')}</span>
                    <span className="info-value">{formatLastActive(session.lastActive)}</span>
                  </div>
                </div>
              )}

              <div className="card-actions">
                <button className="btn-action" onClick={() => setSelectedSession(session)}>
                  <Eye size={16} />
                  {t('sessions.actions.view')}
                </button>
                {canWrite &&
                  (session.status === 'created' || session.status === 'idle' || session.status === 'disconnected') ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <Play size={16} />
                    {t('sessions.actions.start')}
                  </button>
                ) : canWrite && ['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) ? (
                  <button className="btn-action" onClick={() => handleStop(session.id)}>
                    <Square size={16} />
                    {t('sessions.actions.stop')}
                  </button>
                ) : canWrite ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <RefreshCw size={16} />
                    {t('sessions.actions.reconnect')}
                  </button>
                ) : null}
                {canWrite && (
                  <button className="btn-action danger" onClick={() => setDeleteConfirmId(session.id)}>
                    <Trash2 size={16} />
                    {t('sessions.actions.delete')}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
