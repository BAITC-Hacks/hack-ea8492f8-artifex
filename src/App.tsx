import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileJson2,
  Files,
  FileText,
  GitBranch,
  GitMerge,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  Network,
  Pencil,
  Play,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
  Waypoints,
  X,
} from 'lucide-react';
import {
  CanonicalSchema,
  type AnalysisRun,
  type EvidenceRef,
  type Finding,
  type GraphInput,
  type Match,
  type MatchStatus,
  type NormalizedFunction,
  type Review,
} from '../shared/schema';
import { toInput } from '../shared/input';
import { locateQuote } from '../shared/text';
import { api } from './api';
import DocumentWorkspace from './DocumentWorkspace';
import type { ExtractedPair } from '../shared/extraction';
const LazyOrgGraph = lazy(() => import('./OrgGraph'));
function OrgGraph(props: ComponentProps<typeof LazyOrgGraph>) {
  return (
    <Suspense
      fallback={
        <div className="empty-state">
          <LoaderCircle className="spin" size={22} />
          <p>Loading organization...</p>
        </div>
      }
    >
      <LazyOrgGraph {...props} />
    </Suspense>
  );
}

type View = 'overview' | 'lineage' | 'findings' | 'organization' | 'sources' | 'extract';
type Config = { aiAvailable: boolean; model: string; engineVersion: string };
type History = { id: string; title: string; createdAt: string }[];
type SelectedDoc = { side: 'before' | 'after'; id: string; quote?: string };
const labels: Record<string, string> = {
  preserved: 'Preserved',
  transferred: 'Transferred',
  split: 'Split',
  merged: 'Merged',
  partial: 'Partial coverage',
  changed: 'Changed',
  unmatched: 'No successor',
  uncertain: 'Needs review',
  loss: 'Potential gap',
  change: 'Changed responsibility',
  duplication: 'Duplicate ownership',
  conflict: 'Potential conflict',
  evidence: 'Evidence issue',
  uncertainty: 'Uncertain match',
  unreviewed: 'Unreviewed',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
};
const outcomeOrder: MatchStatus[] = [
  'preserved',
  'transferred',
  'split',
  'merged',
  'partial',
  'changed',
  'unmatched',
  'uncertain',
];
const nav = [
  { id: 'extract', label: 'Document extraction', icon: FileJson2 },
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'lineage', label: 'Function lineage', icon: GitMerge },
  { id: 'findings', label: 'Review findings', icon: ShieldAlert },
  { id: 'organization', label: 'Organization', icon: Network },
  { id: 'sources', label: 'Source documents', icon: Files },
] as const;
const defaultReview: Review = { status: 'unreviewed', note: '' };
const display = (value: unknown) =>
  value === null
    ? 'Not stated'
    : Array.isArray(value)
      ? value.length
        ? value.join(', ')
        : 'Unknown'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value).replaceAll('_', ' ');

function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className={`badge badge-${value}`}>
      <span className="badge-dot" />
      {children ?? labels[value] ?? value}
    </span>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
  drawer = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${wide ? 'modal-wide' : ''} ${drawer ? 'drawer' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="modal-header">
        <span>{title}</span>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog" title="Close">
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function EvidenceCard({ evidence, onOpen }: { evidence: EvidenceRef; onOpen: (doc: SelectedDoc) => void }) {
  return (
    <article className="evidence-card">
      <div className="evidence-top">
        <span className={`snapshot-label ${evidence.snapshot}`}>{evidence.snapshot}</span>
        <span className={evidence.verified ? 'verified' : 'not-verified'}>
          {evidence.verified ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
          {evidence.verified ? 'Quote located' : 'Not located'}
        </span>
      </div>
      <blockquote>{evidence.quote}</blockquote>
      <button
        className="source-link"
        onClick={() => onOpen({ side: evidence.snapshot, id: evidence.documentId, quote: evidence.quote })}
      >
        <FileText size={15} />
        <span>
          {evidence.documentTitle}
          <small>{evidence.locator}</small>
        </span>
        <ArrowUpRight size={15} />
      </button>
    </article>
  );
}

function FindingDrawer({
  finding,
  review,
  saving,
  onSave,
  onClose,
  onOpenSource,
  run,
  error,
}: {
  finding: Finding;
  review: Review;
  saving: boolean;
  onSave: (review: Review) => Promise<void>;
  onClose: () => void;
  onOpenSource: (doc: SelectedDoc) => void;
  run: AnalysisRun;
  error: string;
}) {
  const [note, setNote] = useState(review.note);
  const changes = run.result.matches
    .filter((m) => finding.beforeIds.includes(m.beforeId))
    .flatMap((m) => m.differences);
  return (
    <Modal title="Finding review" onClose={onClose} drawer>
      <div className="drawer-body">
        <div className="row-between">
          <Badge value={finding.kind} />
          <span className={`severity ${finding.severity}`}>{finding.severity} priority</span>
        </div>
        <h2>{finding.title}</h2>
        {(['before', 'after'] as const).map((side) => {
          const ids = new Set(
            (side === 'before' ? finding.beforeIds : finding.afterIds)
              .map((id) => run.result.graph[side].functions.find((f) => f.id === id)?.departmentId)
              .filter(Boolean),
          );
          if (side === 'after' && !finding.beforeIds.length && !finding.afterIds.length)
            finding.departmentIds.forEach((id) => ids.add(id));
          const names = run.result.graph[side].departments.filter((d) => ids.has(d.id)).map((d) => d.name);
          return (
            names.length > 0 && (
              <p className="affected-departments" key={side}>
                <span>{side}</span>
                {names.join(', ')}
              </p>
            )
          );
        })}
        <p className="body-copy">{finding.explanation}</p>
        <div className="recommendation">
          <ShieldCheck size={18} />
          <div>
            <strong>Recommended action</strong>
            <p>{finding.recommendation}</p>
          </div>
        </div>
        {changes.length > 0 && (
          <section className="drawer-section">
            <h3>What changed</h3>
            <div className="field-differences">
              {changes.map((c, i) => (
                <div key={i}>
                  <span>{c.field}</span>
                  <div>
                    <del>{c.before}</del>
                    <ArrowRight size={13} />
                    <strong>{c.after}</strong>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className="drawer-section">
          <div className="section-heading">
            <h3>Source evidence</h3>
            <span className="count">{finding.evidence.length}</span>
          </div>
          {finding.evidence.map((e, i) => (
            <EvidenceCard key={i} evidence={e} onOpen={onOpenSource} />
          ))}
        </section>
        <section className="drawer-section">
          <label className="field-label" htmlFor="review-note">
            Reviewer note
          </label>
          <textarea
            id="review-note"
            rows={4}
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Record your decision and context..."
          />
          <div className="note-actions">
            <Badge value={review.status} />
            <button
              className="text-button"
              disabled={saving || note === review.note}
              onClick={() => void onSave({ ...review, note })}
            >
              Save note
            </button>
          </div>
        </section>
        <p className="rule-label">
          {finding.rule}{' '}
          <span>{finding.basis === 'candidate' ? 'Candidate finding' : 'Rule-based check'}</span>
        </p>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="drawer-footer">
        {review.status !== 'unreviewed' && (
          <button
            className="button subtle"
            disabled={saving}
            onClick={() => void onSave({ status: 'unreviewed', note })}
          >
            Reopen
          </button>
        )}
        <button
          className="button secondary"
          disabled={saving}
          onClick={() => void onSave({ status: 'dismissed', note })}
        >
          <X size={16} />
          Dismiss
        </button>
        <button
          className="button primary"
          disabled={saving}
          onClick={() => void onSave({ status: 'confirmed', note })}
        >
          {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Confirm finding
        </button>
      </div>
    </Modal>
  );
}

function CanonicalTable({ fn }: { fn: NormalizedFunction }) {
  return (
    <dl className="canonical-table">
      {Object.entries(fn.canonical).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            {key === 'conditions' && Array.isArray(value) && !value.length
              ? 'None stated'
              : key === 'scope' && Array.isArray(value) && value.includes('*')
                ? 'All documented scope'
                : display(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function App() {
  const [view, setView] = useState<View>('overview');
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [config, setConfig] = useState<Config>({ aiAvailable: false, model: '', engineVersion: '1.0.0' });
  const [history, setHistory] = useState<History>([]);
  const [busy, setBusy] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(''),
    [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false),
    [exportOpen, setExportOpen] = useState(false);
  const [search, setSearch] = useState(''),
    [kindFilter, setKindFilter] = useState('all'),
    [reviewFilter, setReviewFilter] = useState('all'),
    [statusFilter, setStatusFilter] = useState('all');
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<SelectedDoc | null>(null);
  const [graphSide, setGraphSide] = useState<'before' | 'after'>('after'),
    [oversight, setOversight] = useState(true),
    [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false),
    [importText, setImportText] = useState(''),
    [importError, setImportError] = useState(''),
    [mode, setMode] = useState<'local' | 'ai'>('local');
  const [editing, setEditing] = useState<{ side: 'before' | 'after'; id: string } | null>(null),
    [editText, setEditText] = useState(''),
    [editError, setEditError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const sourceHighlight = useRef<HTMLElement>(null);

  const refreshHistory = async () => setHistory(await api<History>('/api/runs'));
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void (async () => {
      try {
        const [settings, runs] = await Promise.all([api<Config>('/api/config'), api<History>('/api/runs')]);
        setConfig(settings);
        setHistory(runs);
        if (runs.length) setRun(await api<AnalysisRun>(`/api/runs/${runs[0].id}`));
        else {
          const graph = await api<GraphInput>('/api/demo');
          setRun(
            await api<AnalysisRun>('/api/analyze', {
              method: 'POST',
              body: JSON.stringify({ graph, normalization: 'local' }),
            }),
          );
          await refreshHistory();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the workspace.');
      } finally {
        setBusy(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  useEffect(() => {
    sourceHighlight.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedDoc]);

  const result = run?.result;
  const navigate = (next: View) => {
    setView(next);
    setSearch('');
    setMobileNav(false);
    window.scrollTo(0, 0);
  };
  const departmentName = (side: 'before' | 'after', id: string) =>
    result?.graph[side].departments.find((d) => d.id === id)?.name ?? id;
  const getFunction = (side: 'before' | 'after', id: string) =>
    result!.graph[side].functions.find((f) => f.id === id)!;
  const currentReview = (id: string) => run?.reviews[id] ?? defaultReview;
  const openSource = (doc: SelectedDoc) => {
    setSelectedDoc(doc);
    setSelectedFinding(null);
    setSelectedMatch(null);
    navigate('sources');
  };
  const startAnalysis = async (
    graph: GraphInput | ExtractedPair,
    normalization: 'local' | 'ai' = 'local',
  ) => {
    setBusy(true);
    setError('');
    try {
      const next = await api<AnalysisRun>('/api/analyze', {
        method: 'POST',
        body: JSON.stringify({ graph, normalization }),
      });
      setRun(next);
      setSelectedFinding(null);
      setSelectedMatch(null);
      setSelectedDept(null);
      setSelectedDoc(null);
      await refreshHistory();
      return next;
    } finally {
      setBusy(false);
    }
  };
  const loadSample = async () => {
    try {
      await startAnalysis(await api<GraphInput>('/api/demo'));
      navigate('overview');
      setToast('Sample analysis loaded');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadHistory = async (id: string) => {
    setBusy(true);
    try {
      setRun(await api<AnalysisRun>(`/api/runs/${id}`));
      setSelectedDoc(null);
      setSelectedDept(null);
      navigate('overview');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveReview = async (review: Review) => {
    if (!selectedFinding || !run) return;
    setSaving(true);
    try {
      const saved = await api<Review>(`/api/runs/${run.result.id}/findings/${selectedFinding}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: review.status, note: review.note }),
      });
      setRun((old) => (old ? { ...old, reviews: { ...old.reviews, [selectedFinding]: saved } } : old));
      setToast('Review saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const importGraph = async () => {
    try {
      setImportError('');
      const graph = JSON.parse(importText) as GraphInput;
      await startAnalysis(graph, mode);
      setImportOpen(false);
      navigate('overview');
      setToast('Analysis complete');
    } catch (e) {
      setImportError((e as Error).message);
    }
  };
  const beginEdit = (side: 'before' | 'after', id: string) => {
    setEditing({ side, id });
    setEditText(JSON.stringify(getFunction(side, id).canonical, null, 2));
    setEditError('');
  };
  const saveEdit = async () => {
    if (!editing || !result) return;
    try {
      setEditError('');
      const canonical = CanonicalSchema.parse(JSON.parse(editText));
      if (result.extraction) {
        const input = structuredClone(result.extraction);
        const sourceId = getFunction(editing.side, editing.id).sourceFunctionId ?? editing.id;
        const fn = input[editing.side].functions.find((f) => f.id === sourceId)!;
        fn.canonical = canonical;
        fn.origin = 'manual';
        await startAnalysis(input);
      } else {
        const input = toInput(result.graph);
        const fn = input[editing.side].functions.find((f) => f.id === editing.id)!;
        fn.canonical = canonical;
        fn.normalizationNotes = [];
        await startAnalysis(input);
      }
      setEditing(null);
      setToast('Correction saved in a new analysis');
    } catch (e) {
      setEditError((e as Error).message);
    }
  };

  const finding = result?.findings.find((f) => f.id === selectedFinding);
  const match = result?.matches.find((m) => m.beforeId === selectedMatch);
  const filteredFindings = useMemo(
    () =>
      result?.findings.filter(
        (f) =>
          (kindFilter === 'all' || f.kind === kindFilter) &&
          (reviewFilter === 'all' || (run?.reviews[f.id]?.status ?? 'unreviewed') === reviewFilter) &&
          `${f.title} ${f.explanation} ${f.rule}`.toLowerCase().includes(search.toLowerCase()),
      ) ?? [],
    [result, run?.reviews, kindFilter, reviewFilter, search],
  );
  const filteredMatches =
    result?.matches.filter(
      (m) =>
        (statusFilter === 'all' || m.status === statusFilter) &&
        `${getFunction('before', m.beforeId).description} ${departmentName('before', getFunction('before', m.beforeId).departmentId)}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? [];
  const openFindings = result?.findings.filter((f) => currentReview(f.id).status === 'unreviewed') ?? [];
  const coverage = result?.metrics.totalBefore
    ? Math.round((result.metrics.fullyCovered / result.metrics.totalBefore) * 100)
    : null;
  const documents = result
    ? (['before', 'after'] as const).flatMap((side) =>
        result.graph[side].documents.map((doc) => ({ side, ...doc })),
      )
    : [];
  const activeDoc =
    documents.find((d) => d.side === selectedDoc?.side && d.id === selectedDoc?.id) ?? documents[0];
  const sourceRange = activeDoc && selectedDoc?.quote ? locateQuote(activeDoc.text, selectedDoc.quote) : null;
  const sourceParts =
    activeDoc && sourceRange
      ? [activeDoc.text.slice(0, sourceRange.start), activeDoc.text.slice(sourceRange.end)]
      : null;

  const findingTable = (items: Finding[]) => (
    <div className="table-scroll">
      <table className="findings-table">
        <thead>
          <tr>
            <th>Finding</th>
            <th>Priority</th>
            <th>Review</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.id}>
              <td>
                <button className="table-link" onClick={() => setSelectedFinding(f.id)}>
                  <span className={`finding-icon ${f.kind}`}>
                    {f.kind === 'conflict' ? (
                      <ShieldAlert size={17} />
                    ) : f.kind === 'loss' ? (
                      <CircleAlert size={17} />
                    ) : (
                      <GitBranch size={17} />
                    )}
                  </span>
                  <span>
                    <strong>{f.title}</strong>
                    <small>{labels[f.kind]}</small>
                  </span>
                </button>
              </td>
              <td>
                <span className={`severity ${f.severity}`}>
                  <span />
                  {f.severity}
                </span>
              </td>
              <td>
                <Badge value={currentReview(f.id).status} />
              </td>
              <td>
                <button
                  className="icon-button"
                  title="Review finding"
                  aria-label={`Review ${f.title}`}
                  onClick={() => setSelectedFinding(f.id)}
                >
                  <ChevronRight size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="empty-state">
          <CheckCircle2 size={27} />
          <h3>No matching findings</h3>
          <p>
            {result?.findings.length
              ? 'Adjust the active filters.'
              : 'No review flags from the configured rules.'}
          </p>
        </div>
      )}
    </div>
  );

  return (
    <div className="app-shell">
      {mobileNav && (
        <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
        <a
          href="#overview"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <span className="brand-mark">
            <Waypoints size={23} strokeWidth={1.7} />
          </span>
          <span>
            lineage<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">H</span>
          <div>
            <strong>HackAlem</strong>
            <small>Organization analysis</small>
          </div>
          <span className="local-indicator" title="Local workspace" />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === 'findings' && openFindings.length > 0 && (
                <span className="nav-count">{openFindings.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-history">
          <div className="nav-caption">RECENT ANALYSES</div>
          <select
            aria-label="Select saved analysis"
            value={result?.id ?? ''}
            onChange={(e) => void loadHistory(e.target.value)}
            disabled={busy || !history.length}
          >
            <option value="" disabled>
              Select analysis
            </option>
            {history.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} ·{' '}
                {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </option>
            ))}
          </select>
          <button className="nav-item" onClick={() => void loadSample()} disabled={busy}>
            <BookOpen size={17} />
            <span>Load sample case</span>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          <div>
            <strong>Local workspace</strong>
            <small>Engine {config.engineVersion}</small>
          </div>
          <ShieldCheck size={17} />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            <span>Organization</span>
            <ChevronRight size={13} />
            <strong>{nav.find((n) => n.id === view)?.label}</strong>
          </div>
          <div className="topbar-actions">
            <span className="connection-status">
              <span className="status-dot" />
              {config.aiAvailable ? 'AI connected' : 'Local engine'}
            </span>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => {
                setImportText('');
                setImportError('');
                setImportOpen(true);
              }}
            >
              <Upload size={15} />
              Import graph
            </button>
          </div>
        </header>
        <main>
          <div hidden={view !== 'extract'}>
            <h1 className="extraction-title">Document extraction</h1>
            <DocumentWorkspace
              aiAvailable={config.aiAvailable}
              model={config.model}
              onAnalyze={async (pair) => {
                const next = await startAnalysis(pair);
                navigate('overview');
                return next;
              }}
            />
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={18} />
              <span>{error}</span>
              <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          <div className="page-heading" hidden={view === 'extract'}>
            <div>
              <div className="eyebrow">ORGANIZATION REVIEW</div>
              <h1>
                {view === 'overview'
                  ? (result?.title ?? 'Review workspace')
                  : nav.find((n) => n.id === view)?.label}
              </h1>
              <div className="date-range">
                <span>{result?.graph.before.date ?? 'Before'}</span>
                <ArrowRight size={14} />
                <span>{result?.graph.after.date ?? 'After'}</span>
                <span className="divider-dot" />
                <span>
                  {result
                    ? `${result.graph.before.functions.length} original functions`
                    : 'No analysis loaded'}
                </span>
              </div>
            </div>
            <div className="heading-actions">
              <div ref={exportRef} className="export-wrapper">
                <button
                  className="button secondary"
                  disabled={!run || busy}
                  onClick={() => setExportOpen(!exportOpen)}
                >
                  <ArrowDownToLine size={16} />
                  Export
                  <ChevronDown size={14} />
                </button>
                {exportOpen && result && (
                  <div className="dropdown" role="menu">
                    {[
                      ['html', 'Open printable report', FileText],
                      ['csv', 'Download findings CSV', ArrowDownToLine],
                      ['json', 'Download full analysis', FileJson2],
                      ['graph', 'Download normalized graph', Network],
                      ...(result.extraction
                        ? [['extraction', 'Download graph and functions', FileJson2]]
                        : []),
                    ].map(([format, text, Icon]) => {
                      const I = Icon as typeof FileText;
                      return (
                        <a
                          key={String(format)}
                          role="menuitem"
                          target={format === 'html' ? '_blank' : undefined}
                          rel="noreferrer"
                          href={`/api/runs/${result.id}/export/${String(format)}`}
                          onClick={() => setExportOpen(false)}
                        >
                          <I size={16} />
                          {String(text)}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                className="button primary"
                disabled={!run || busy}
                onClick={() => {
                  if (result)
                    void startAnalysis(result.extraction ?? toInput(result.graph))
                      .then(() => setToast('New analysis complete'))
                      .catch((e) => setError(e.message));
                }}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={15} />}Run analysis
              </button>
            </div>
          </div>
          {busy && (
            <div className="progress-strip" role="status">
              <LoaderCircle size={15} className="spin" />
              <span>
                {run ? 'Analyzing responsibilities and evidence...' : 'Loading review workspace...'}
              </span>
              <div />
            </div>
          )}
          {!result && !busy && (
            <div className="empty-state large">
              <Network size={40} />
              <h2>No analysis loaded</h2>
              <button className="button primary" onClick={() => void loadSample()}>
                Load sample case
              </button>
            </div>
          )}
          {result && view === 'overview' && (
            <>
              {result.extraction && (
                <div className="extraction-progress" role="status">
                  <CircleAlert size={18} />
                  <span>
                    Extraction needs review:{' '}
                    {result.extraction.before.functions.filter((f) => !f.ownerIds.length).length} before and{' '}
                    {result.extraction.after.functions.filter((f) => !f.ownerIds.length).length} after
                    responsibilities have unresolved owners. These remain in the JSON and are excluded from
                    ownership comparison.
                  </span>
                </div>
              )}
              <section className="metrics-band">
                <div className="metric">
                  <span>
                    Documented coverage <ShieldCheck size={15} />
                  </span>
                  <strong>
                    {coverage ?? '—'}
                    <small>{coverage === null ? '' : '%'}</small>
                  </strong>
                  <p>
                    {result.metrics.fullyCovered} of {result.metrics.totalBefore} functions fully covered
                  </p>
                </div>
                <div className="metric">
                  <span>
                    Awaiting review <CircleAlert size={15} />
                  </span>
                  <strong>
                    {openFindings.length}
                    <i className="metric-alert" />
                  </strong>
                  <p>{openFindings.filter((f) => f.severity === 'high').length} high-priority findings</p>
                </div>
                <div className="metric">
                  <span>
                    Departments <Network size={15} />
                  </span>
                  <strong className="metric-transition">
                    {result.graph.before.departments.filter((d) => !d.kind || d.kind === 'unit').length}
                    <ArrowRight size={22} />
                    {result.graph.after.departments.filter((d) => !d.kind || d.kind === 'unit').length}
                  </strong>
                  <p>
                    {result.departmentChanges.filter((d) => d.status !== 'preserved').length} structural
                    changes
                  </p>
                </div>
                <div className="metric">
                  <span>
                    Source quotations <Files size={15} />
                  </span>
                  <strong>
                    {result.metrics.verifiedEvidence}
                    <small>/{result.metrics.totalEvidence}</small>
                  </strong>
                  <p>Located in supplied source text</p>
                </div>
              </section>
              <div className="overview-grid">
                <section className="continuity-section">
                  <div className="section-heading">
                    <div>
                      <h2>Function continuity</h2>
                      <p>
                        {result.graph.before.label} to {result.graph.after.label}
                      </p>
                    </div>
                    <button className="text-button" onClick={() => navigate('lineage')}>
                      View lineage
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                  <div className="continuity-bar" aria-label="Function outcomes">
                    {outcomeOrder.map((status) => {
                      const count = result.matches.filter((m) => m.status === status).length;
                      return (
                        count > 0 && (
                          <button
                            key={status}
                            className={`bar-${status}`}
                            style={{ flex: count }}
                            title={`${labels[status]}: ${count}`}
                            aria-label={`${labels[status]}: ${count}`}
                            onClick={() => {
                              setStatusFilter(status);
                              navigate('lineage');
                            }}
                          >
                            {count}
                          </button>
                        )
                      );
                    })}
                  </div>
                  <div className="continuity-legend">
                    {outcomeOrder.map((status) => {
                      const count = result.matches.filter((m) => m.status === status).length;
                      return (
                        count > 0 && (
                          <button
                            key={status}
                            onClick={() => {
                              setStatusFilter(status);
                              navigate('lineage');
                            }}
                          >
                            <span className={`legend-dot bar-${status}`} />
                            <span>{labels[status]}</span>
                            <strong>{count}</strong>
                          </button>
                        )
                      );
                    })}
                  </div>
                  <div className="section-heading findings-heading">
                    <div>
                      <h2>Priority review</h2>
                      <p>Findings requiring a decision</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => {
                        setReviewFilter('unreviewed');
                        navigate('findings');
                      }}
                    >
                      View all
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {findingTable(openFindings.slice(0, 5))}
                </section>
                <aside className="overview-aside">
                  <div className="section-heading">
                    <h2>Review progress</h2>
                    <Clock3 size={16} />
                  </div>
                  <div className="review-progress">
                    <div
                      className="progress-ring"
                      style={
                        {
                          '--progress': `${result.findings.length ? ((result.findings.length - openFindings.length) / result.findings.length) * 360 : 360}deg`,
                        } as React.CSSProperties
                      }
                    >
                      <div>
                        <strong>
                          {result.findings.length - openFindings.length}
                          <small>/{result.findings.length}</small>
                        </strong>
                        <span>reviewed</span>
                      </div>
                    </div>
                    <div className="review-breakdown">
                      {(['unreviewed', 'confirmed', 'dismissed'] as const).map((status) => (
                        <button
                          key={status}
                          onClick={() => {
                            setReviewFilter(status);
                            navigate('findings');
                          }}
                        >
                          <Badge value={status} />
                          <strong>
                            {result.findings.filter((f) => currentReview(f.id).status === status).length}
                          </strong>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="run-detail-section">
                    <div className="section-heading">
                      <h2>Analysis details</h2>
                      <span className="tiny-tag">v{result.engineVersion}</span>
                    </div>
                    <dl className="run-details">
                      <div>
                        <dt>Candidate comparisons</dt>
                        <dd>
                          {result.metrics.candidateComparisons}
                          <span> / {result.metrics.possibleComparisons}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>Model calls</dt>
                        <dd>{result.metrics.aiCalls}</dd>
                      </div>
                      <div>
                        <dt>Cached normalizations</dt>
                        <dd>{result.metrics.normalizationCacheHits}</dd>
                      </div>
                      <div>
                        <dt>Processing time</dt>
                        <dd>
                          {result.metrics.durationMs < 1000
                            ? `${result.metrics.durationMs} ms`
                            : `${(result.metrics.durationMs / 1000).toFixed(1)} s`}
                        </dd>
                      </div>
                      <div>
                        <dt>Input / output tokens</dt>
                        <dd>
                          {result.metrics.inputTokens} / {result.metrics.outputTokens}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="source-summary">
                    <Files size={19} />
                    <div>
                      <strong>{documents.length} source documents</strong>
                      <span>
                        {result.graph.before.documents.length} before · {result.graph.after.documents.length}{' '}
                        after
                      </span>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="View source documents"
                      title="Source documents"
                      onClick={() => navigate('sources')}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  </div>
                </aside>
              </div>
              <details className="method-note">
                <summary>
                  <ShieldCheck size={16} />
                  Analysis scope and limitations
                  <ChevronDown size={15} />
                </summary>
                <ul>
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {result && view === 'findings' && (
            <section>
              <div className="toolbar">
                <div className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="Search findings"
                    placeholder="Search findings..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  aria-label="Filter finding type"
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                >
                  <option value="all">All finding types</option>
                  {['loss', 'change', 'duplication', 'conflict', 'evidence', 'uncertainty'].map((k) => (
                    <option key={k} value={k}>
                      {labels[k]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter review status"
                  value={reviewFilter}
                  onChange={(e) => setReviewFilter(e.target.value)}
                >
                  <option value="all">All review states</option>
                  {['unreviewed', 'confirmed', 'dismissed'].map((k) => (
                    <option key={k} value={k}>
                      {labels[k]}
                    </option>
                  ))}
                </select>
                <span className="toolbar-count">{filteredFindings.length} findings</span>
              </div>
              {findingTable(filteredFindings)}
            </section>
          )}
          {result && view === 'lineage' && (
            <section>
              <div className="toolbar">
                <div className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="Search functions"
                    placeholder="Search functions or departments..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  aria-label="Filter lineage status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All outcomes</option>
                  {outcomeOrder.map((s) => (
                    <option key={s} value={s}>
                      {labels[s]}
                    </option>
                  ))}
                </select>
                <span className="toolbar-count">{filteredMatches.length} functions</span>
              </div>
              <div className="table-scroll">
                <table className="lineage-table">
                  <thead>
                    <tr>
                      <th>Original responsibility</th>
                      <th>Before owner</th>
                      <th>After owner</th>
                      <th>Outcome</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMatches.map((m) => {
                      const fn = getFunction('before', m.beforeId);
                      return (
                        <tr key={m.beforeId}>
                          <td>
                            <button className="table-link" onClick={() => setSelectedMatch(m.beforeId)}>
                              <span>
                                <strong>
                                  {display(fn.canonical.action)} {fn.canonical.object}
                                </strong>
                                <small>{fn.description}</small>
                              </span>
                            </button>
                          </td>
                          <td>{departmentName('before', fn.departmentId)}</td>
                          <td>
                            {m.afterIds.length ? (
                              [
                                ...new Set(
                                  m.afterIds.map((id) =>
                                    departmentName('after', getFunction('after', id).departmentId),
                                  ),
                                ),
                              ].join(', ')
                            ) : (
                              <span className="muted">No match found</span>
                            )}
                          </td>
                          <td>
                            <Badge value={m.status} />
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`Inspect ${fn.id}`}
                              title="Inspect function"
                              onClick={() => setSelectedMatch(m.beforeId)}
                            >
                              <ChevronRight size={17} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!filteredMatches.length && (
                  <div className="empty-state">
                    <Search size={26} />
                    <h3>No matching functions</h3>
                    <button
                      className="text-button"
                      onClick={() => {
                        setSearch('');
                        setStatusFilter('all');
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                )}
              </div>
              {result.newFunctionIds.length > 0 && (
                <section className="unlinked-section">
                  <div className="section-heading">
                    <h2>After-functions without a linked predecessor</h2>
                    <span className="count">{result.newFunctionIds.length}</span>
                  </div>
                  {result.newFunctionIds.map((id) => {
                    const fn = getFunction('after', id);
                    return (
                      <div key={id} className="unlinked-row">
                        <Plus size={17} />
                        <div>
                          <strong>{fn.description}</strong>
                          <small>{departmentName('after', fn.departmentId)}</small>
                        </div>
                        <button
                          className="icon-button"
                          onClick={() => beginEdit('after', id)}
                          title="Edit normalized fields"
                          aria-label={`Edit ${id}`}
                        >
                          <Pencil size={15} />
                        </button>
                      </div>
                    );
                  })}
                </section>
              )}
            </section>
          )}
          {result && view === 'organization' && (
            <section>
              <div className="toolbar">
                <div className="segmented" role="group" aria-label="Organization snapshot">
                  {(['before', 'after'] as const).map((side) => (
                    <button
                      key={side}
                      className={graphSide === side ? 'selected' : ''}
                      onClick={() => {
                        setGraphSide(side);
                        setSelectedDept(null);
                      }}
                    >
                      {side === 'before' ? 'Before reorganization' : 'After reorganization'}
                    </button>
                  ))}
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={oversight}
                    onChange={(e) => setOversight(e.target.checked)}
                  />
                  Reporting and oversight
                </label>
                <span className="toolbar-count">
                  {result.graph[graphSide].departments.length}{' '}
                  {result.graph[graphSide].hierarchyKind === 'containment' ? 'entities' : 'departments'}
                </span>
              </div>
              <div className="organization-layout">
                <div className="graph-surface">
                  <OrgGraph
                    snapshot={result.graph[graphSide]}
                    oversight={oversight}
                    onSelect={setSelectedDept}
                  />
                </div>
                {selectedDept && (
                  <aside className="department-panel">
                    <div className="section-heading">
                      <h3>{departmentName(graphSide, selectedDept)}</h3>
                      <button
                        className="icon-button"
                        onClick={() => setSelectedDept(null)}
                        aria-label="Close department"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    {result.graph[graphSide].functions
                      .filter((f) => f.departmentId === selectedDept)
                      .map((fn) => (
                        <button
                          className="department-function"
                          key={fn.id}
                          onClick={() => beginEdit(graphSide, fn.id)}
                        >
                          <span>{fn.description}</span>
                          <Pencil size={14} />
                        </button>
                      ))}
                    {!result.graph[graphSide].functions.some((f) => f.departmentId === selectedDept) && (
                      <p className="muted">No functions in this snapshot.</p>
                    )}
                  </aside>
                )}
              </div>
              <div className="section-heading structural-heading">
                <h2>Department transitions</h2>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Before</th>
                      <th>After</th>
                      <th>Change</th>
                      <th>Mapping basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.departmentChanges.map((d, i) => (
                      <tr key={i}>
                        <td>
                          {d.beforeIds.map((id) => departmentName('before', id)).join(', ') || 'None mapped'}
                        </td>
                        <td>
                          {d.afterIds.map((id) => departmentName('after', id)).join(', ') || 'None mapped'}
                        </td>
                        <td>
                          <Badge value={d.status} />
                        </td>
                        <td className="muted">{d.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {result && view === 'sources' && (
            <section className="sources-layout">
              <aside className="document-list">
                {(['before', 'after'] as const).map((side) => (
                  <div key={side}>
                    <div className="nav-caption">{side.toUpperCase()} REORGANIZATION</div>
                    {documents
                      .filter((d) => d.side === side)
                      .map((doc) => (
                        <button
                          key={doc.id}
                          className={activeDoc?.id === doc.id && activeDoc.side === doc.side ? 'active' : ''}
                          onClick={() => setSelectedDoc({ side, id: doc.id })}
                        >
                          <FileText size={18} />
                          <span>
                            {doc.title}
                            <small>{doc.text.length.toLocaleString()} characters</small>
                          </span>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                  </div>
                ))}
              </aside>
              <article className="document-view">
                {activeDoc ? (
                  <>
                    <div className="document-heading">
                      <span className={`snapshot-label ${activeDoc.side}`}>{activeDoc.side}</span>
                      <span className="tiny-tag">Imported source text</span>
                      <h2>{activeDoc.title}</h2>
                    </div>
                    <div className="document-text">
                      {sourceParts
                        ? sourceParts.map((part, i) => (
                            <span key={i}>
                              {i > 0 && (
                                <mark ref={i === 1 ? sourceHighlight : undefined}>{selectedDoc!.quote}</mark>
                              )}
                              {part}
                            </span>
                          ))
                        : activeDoc.text}
                    </div>
                  </>
                ) : (
                  <div className="empty-state">
                    <Files size={30} />
                    <h3>No documents in this graph</h3>
                  </div>
                )}
              </article>
            </section>
          )}
          <footer className="page-footer">
            <span>
              <Waypoints size={13} />
              Lineage
            </span>
            <span>
              {result
                ? `Analysis ${result.id.slice(0, 8)} · ${new Date(result.createdAt).toLocaleString()}`
                : 'Organization review workspace'}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {finding && run && (
        <FindingDrawer
          key={finding.id}
          finding={finding}
          review={currentReview(finding.id)}
          saving={saving}
          run={run}
          onSave={saveReview}
          error={error}
          onClose={() => setSelectedFinding(null)}
          onOpenSource={openSource}
        />
      )}
      {match && result && (
        <Modal title="Function lineage" onClose={() => setSelectedMatch(null)} wide>
          <div className="modal-body">
            <div className="lineage-detail-heading">
              <Badge value={match.status} />
              <h2>{getFunction('before', match.beforeId).canonical.object}</h2>
              <p>{match.reason}</p>
            </div>
            <div className="function-comparison">
              {[
                { side: 'before' as const, id: match.beforeId },
                ...match.afterIds.map((id) => ({ side: 'after' as const, id })),
              ].map(({ side, id }) => {
                const fn = getFunction(side, id);
                return (
                  <section key={`${side}-${id}`}>
                    <div className="section-heading">
                      <span className={`snapshot-label ${side}`}>{side}</span>
                      <button
                        className="icon-button"
                        aria-label={`Edit normalized fields for ${id}`}
                        title="Edit normalized fields"
                        onClick={() => beginEdit(side, id)}
                      >
                        <Pencil size={15} />
                      </button>
                    </div>
                    <h3>{departmentName(side, fn.departmentId)}</h3>
                    <p className="function-description">{fn.description}</p>
                    <CanonicalTable fn={fn} />
                    <span className="tiny-tag">{fn.normalization} normalization</span>
                    {fn.normalizationWarnings.map((w) => (
                      <p key={w} className="inline-warning">
                        {w}
                      </p>
                    ))}
                    {fn.evidence.map((e, i) => (
                      <button
                        key={i}
                        className="source-link compact"
                        onClick={() => openSource({ side, id: e.documentId, quote: e.quote })}
                      >
                        <FileText size={14} />
                        {e.locator}
                        <ArrowUpRight size={13} />
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
            {match.differences.length > 0 && (
              <details className="method-note">
                <summary>
                  Changed fields
                  <ChevronDown size={15} />
                </summary>
                <div className="field-differences">
                  {match.differences.map((d, i) => (
                    <div key={i}>
                      <span>{d.field}</span>
                      <div>
                        <del>{d.before}</del>
                        <ArrowRight size={13} />
                        <strong>{d.after}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </Modal>
      )}
      {importOpen && (
        <Modal
          title="Import graph"
          onClose={() => {
            if (!busy) setImportOpen(false);
          }}
          wide
        >
          <div className="modal-body">
            <div className="import-toolbar">
              <button className="button secondary" onClick={() => fileRef.current?.click()}>
                <Upload size={16} />
                Choose JSON file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    if (file.size > 12 * 1024 * 1024) {
                      setImportError('The graph must be smaller than 12 MB.');
                      return;
                    }
                    setImportText(await file.text());
                    setImportError('');
                  }
                }}
              />
              <a className="text-button" href="/api/demo" target="_blank" rel="noreferrer">
                Sample input
                <ArrowUpRight size={14} />
              </a>
              <a className="text-button" href="/api/schema" target="_blank" rel="noreferrer">
                Input schema
                <ArrowUpRight size={14} />
              </a>
            </div>
            <label className="field-label" htmlFor="graph-json">
              Graph JSON
            </label>
            <textarea
              id="graph-json"
              className="code-editor"
              rows={14}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={'{ "schemaVersion": "1.0", "before": { ... }, "after": { ... } }'}
              spellCheck={false}
            />
            <div className="normalization-setting">
              <span className="field-label">Normalization</span>
              <div className="segmented">
                <button className={mode === 'local' ? 'selected' : ''} onClick={() => setMode('local')}>
                  Local
                </button>
                <button
                  className={mode === 'ai' ? 'selected' : ''}
                  disabled={!config.aiAvailable}
                  title={config.aiAvailable ? config.model : 'OPENAI_API_KEY is not configured on the server'}
                  onClick={() => setMode('ai')}
                >
                  AI-assisted
                </button>
              </div>
              <span className="muted small-text">
                {mode === 'ai' ? config.model : 'Supplied fields + conservative extraction'}
              </span>
            </div>
            {importError && (
              <pre className="form-error" role="alert">
                {importError}
              </pre>
            )}
          </div>
          <div className="modal-footer">
            <button className="button secondary" disabled={busy} onClick={() => setImportOpen(false)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy || !importText.trim()}
              onClick={() => void importGraph()}
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={15} />}Analyze graph
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal
          title="Edit normalized function"
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <div className="modal-body">
            <p className="function-description">{getFunction(editing.side, editing.id).description}</p>
            <label className="field-label" htmlFor="canonical-json">
              Canonical fields
            </label>
            <textarea
              id="canonical-json"
              className="code-editor"
              rows={16}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
            />
            {editError && (
              <pre className="form-error" role="alert">
                {editError}
              </pre>
            )}
          </div>
          <div className="modal-footer">
            <button className="button secondary" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="button primary" disabled={busy} onClick={() => void saveEdit()}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save and reanalyze
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
