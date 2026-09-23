import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  BookOpen,
  Check,
  CircleAlert,
  FileJson2,
  LoaderCircle,
  Play,
  Trash2,
  Upload,
} from 'lucide-react';
import { ExtractedPairSchema, type ExtractedPair, type SourceDocument } from '../shared/extraction';
import { api } from './api';

type RevisionInput = { revision: { id: string; label: string; date: string }; documents: SourceDocument[] };
type PairRequest = { title: string; before: RevisionInput; after: RevisionInput; mode: 'local' | 'agentic' };
type Job = {
  id: string;
  status: 'running' | 'complete' | 'failed';
  progress: string;
  error?: string;
  result?: ExtractedPair;
};
const empty = (side: string): RevisionInput => ({
  revision: { id: side, label: side === 'before' ? 'Before' : 'After', date: '' },
  documents: [],
});

export default function DocumentWorkspace({
  aiAvailable,
  model,
  onAnalyze,
}: {
  aiAvailable: boolean;
  model: string;
  onAnalyze: (pair: ExtractedPair) => Promise<unknown>;
}) {
  const [request, setRequest] = useState<PairRequest>({
    title: 'Organization review',
    before: empty('before'),
    after: empty('after'),
    mode: 'local',
  });
  const [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState('');
  const [uploading, setUploading] = useState(false),
    [comparing, setComparing] = useState(false);
  const [side, setSide] = useState<'before' | 'after'>('after');
  const [tab, setTab] = useState<'graph' | 'functions' | 'issues' | 'json'>('graph');
  const [json, setJson] = useState(''),
    [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState<{ title: string; quote: string } | null>(null);
  const [notice, setNotice] = useState('');
  const started = useRef(false);
  const running = job?.status === 'running';

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const id = sessionStorage.getItem('lineage-extraction-job');
    if (id)
      void api<Job>(`/api/extraction-jobs/${id}`)
        .then((value) => {
          setJob(value);
          if (value.result) {
            const pair = value.result;
            setJson(JSON.stringify(pair, null, 2));
            setRequest((old) => ({
              ...old,
              title: pair.title,
              before: {
                revision: { ...pair.before.revision, date: pair.before.revision.date ?? '' },
                documents: pair.before.documents.map(({ sha256: _hash, ...document }) => document),
              },
              after: {
                revision: { ...pair.after.revision, date: pair.after.revision.date ?? '' },
                documents: pair.after.documents.map(({ sha256: _hash, ...document }) => document),
              },
            }));
          }
        })
        .catch(() => sessionStorage.removeItem('lineage-extraction-job'));
  }, []);
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<Job>(`/api/extraction-jobs/${job.id}`);
        if (stopped) return;
        setJob(value);
        if (value.result) setJson(JSON.stringify(value.result, null, 2));
        if (value.error) setError(value.error);
        if (value.status === 'running') timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!stopped) {
          setError((e as Error).message);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status]);

  const upload = async (side: 'before' | 'after', files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      if (files.length + request[side].documents.length > 12)
        throw new Error('Maximum 12 documents per revision.');
      const documents: SourceDocument[] = [];
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} exceeds 8 MB.`);
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('Cannot read file.'));
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.readAsDataURL(file);
        });
        documents.push(
          await api<SourceDocument>('/api/documents', {
            method: 'POST',
            body: JSON.stringify({ name: file.name, base64 }),
          }),
        );
      }
      setRequest((old) => ({
        ...old,
        [side]: {
          ...old[side],
          documents: [...new Map([...old[side].documents, ...documents].map((d) => [d.id, d])).values()],
        },
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const start = async () => {
    setError('');
    setNotice('');
    try {
      const { id } = await api<{ id: string }>('/api/extraction-jobs', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      setJob({ id, status: 'running', progress: 'Starting extraction.' });
      setJson('');
      setSelected(null);
      sessionStorage.setItem('lineage-extraction-job', id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const download = () => {
    try {
      JSON.parse(json);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'organization-functions.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Correct the JSON syntax before exporting.');
    }
  };
  const compare = async () => {
    setComparing(true);
    setError('');
    try {
      await onAnalyze(JSON.parse(json) as ExtractedPair);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setComparing(false);
    }
  };
  const applyEdits = () => {
    try {
      const value = ExtractedPairSchema.parse(JSON.parse(json));
      // Full schema, source and graph checks still run on the server before comparison.
      setJob((old) => (old ? { ...old, result: value } : old));
      setNotice('Draft updated. Server validation runs before comparison.');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const result = job?.result?.[side];
  const node = result?.graph.nodes.find((n) => n.id === selected);
  const blocked = running || uploading || comparing;
  return (
    <div className="document-workspace">
      <div className="document-commandbar">
        <label className="field-label">
          Review name
          <input
            value={request.title}
            disabled={blocked}
            onChange={(e) => setRequest({ ...request, title: e.target.value })}
          />
        </label>
        <button
          className="button secondary"
          disabled={blocked}
          onClick={async () => {
            try {
              setRequest(await api<PairRequest>('/api/document-example'));
              setError('');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <BookOpen size={16} />
          Edition 8 / 9
        </button>
      </div>
      <div className="document-revisions">
        {(['before', 'after'] as const).map((which) => (
          <section key={which}>
            <div className="section-heading">
              <h2>{which === 'before' ? 'Before' : 'After'}</h2>
              <span className="muted">{request[which].documents.length} documents</span>
            </div>
            <div className="revision-fields">
              <label className="field-label">
                Revision
                <input
                  value={request[which].revision.label}
                  disabled={blocked}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      [which]: {
                        ...request[which],
                        revision: { ...request[which].revision, label: e.target.value },
                      },
                    })
                  }
                />
              </label>
              <label className="field-label">
                Effective date
                <input
                  type="date"
                  value={request[which].revision.date}
                  disabled={blocked}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      [which]: {
                        ...request[which],
                        revision: { ...request[which].revision, date: e.target.value },
                      },
                    })
                  }
                />
              </label>
            </div>
            <label className="document-upload">
              <Upload size={18} />
              <span>Add documents</span>
              <input
                type="file"
                multiple
                accept=".txt,.md,.docx,.pdf,.xlsx"
                aria-label={`Upload ${which} documents`}
                disabled={blocked}
                onChange={(e) => {
                  void upload(which, e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <ul className="document-file-list">
              {request[which].documents.map((doc) => (
                <li key={doc.id}>
                  <div>
                    <strong>{doc.title}</strong>
                    <small>{doc.text.length.toLocaleString()} characters</small>
                    {doc.ingestionNotes?.map((note) => (
                      <small key={note}>{note}</small>
                    ))}
                  </div>
                  <button
                    className="icon-button"
                    disabled={blocked}
                    title="Remove document"
                    aria-label={`Remove ${doc.title}`}
                    onClick={() =>
                      setRequest({
                        ...request,
                        [which]: {
                          ...request[which],
                          documents: request[which].documents.filter((d) => d.id !== doc.id),
                        },
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="document-commandbar">
        <div className="segmented">
          <button
            disabled={blocked}
            className={request.mode === 'local' ? 'selected' : ''}
            onClick={() => setRequest({ ...request, mode: 'local' })}
          >
            Local baseline
          </button>
          <button
            disabled={blocked || !aiAvailable}
            title={aiAvailable ? model : 'OPENAI_API_KEY is not configured'}
            className={request.mode === 'agentic' ? 'selected' : ''}
            onClick={() => setRequest({ ...request, mode: 'agentic' })}
          >
            Agentic
          </button>
        </div>
        <span className="muted small-text">
          {request.mode === 'agentic' ? model : 'Unreviewed candidates'}
        </span>
        <button
          className="button primary"
          disabled={
            blocked ||
            !request.title.trim() ||
            !request.before.documents.length ||
            !request.after.documents.length ||
            !request.before.revision.date ||
            !request.after.revision.date
          }
          onClick={() => void start()}
        >
          {running ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}Extract JSON
        </button>
      </div>
      {request.mode === 'agentic' && (
        <p className="muted small-text">
          Document text is sent to the configured model provider. Maximum 40 model calls per revision.
        </p>
      )}
      {uploading && <p role="status">Reading document...</p>}
      {job && (
        <div className="extraction-progress" role="status">
          {running ? (
            <LoaderCircle size={18} className="spin" />
          ) : job.status === 'complete' ? (
            <Check size={18} />
          ) : (
            <CircleAlert size={18} />
          )}
          <span>{job.progress}</span>
        </div>
      )}
      {error && (
        <pre className="form-error" role="alert">
          {error}
        </pre>
      )}
      {notice && <p role="status">{notice}</p>}
      {result && (
        <section className="extraction-result">
          <div className="document-commandbar">
            <div className="segmented">
              {(['before', 'after'] as const).map((value) => (
                <button
                  key={value}
                  className={side === value ? 'selected' : ''}
                  onClick={() => {
                    setSide(value);
                    setSelected(null);
                  }}
                >
                  {value === 'before' ? 'Before' : 'After'}
                </button>
              ))}
            </div>
            <span className="extraction-status">{result.coverage.status.replaceAll('_', ' ')}</span>
            <button className="button secondary" onClick={download}>
              <ArrowDownToLine size={16} />
              JSON
            </button>
            <button className="button primary" disabled={blocked} onClick={() => void compare()}>
              {comparing ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}Compare JSON
            </button>
          </div>
          <div className="extraction-counts">
            <span>
              <strong>{result.graph.nodes.length}</strong> entities
            </span>
            <span>
              <strong>{result.graph.edges.length}</strong> relationships
            </span>
            <span>
              <strong>{result.functions.length}</strong> responsibilities
            </span>
            <span>
              <strong>
                {result.coverage.reviewedClauses}/{result.coverage.totalClauses}
              </strong>{' '}
              clauses reviewed
            </span>
            <span>
              <strong>{result.metrics.calls}</strong> model calls
            </span>
          </div>
          <div className="document-commandbar">
            <div className="segmented">
              {(['graph', 'functions', 'issues', 'json'] as const).map((value) => (
                <button
                  key={value}
                  className={tab === value ? 'selected' : ''}
                  onClick={() => {
                    setTab(value);
                    setSearch('');
                  }}
                >
                  {value === 'json' ? 'JSON' : value[0].toUpperCase() + value.slice(1)}
                  {value === 'issues' ? ` (${result.issues.length})` : ''}
                </button>
              ))}
            </div>
            {tab !== 'json' && (
              <input
                className="extraction-search"
                aria-label="Search extraction"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
          </div>
          {tab === 'graph' && (
            <>
              <div className="table-scroll">
                <table className="extraction-table">
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th>Type</th>
                      <th>Unit</th>
                      <th>Functions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.graph.nodes
                      .filter((n) => `${n.name} ${n.kind}`.toLowerCase().includes(search.toLowerCase()))
                      .map((n) => (
                        <tr key={n.id}>
                          <td>
                            <button className="text-button" onClick={() => setSelected(n.id)}>
                              {n.name}
                            </button>
                          </td>
                          <td>{n.kind}</td>
                          <td>
                            {result.graph.nodes.find((x) => x.id === n.scopeId)?.name ?? 'Not specified'}
                          </td>
                          <td>{n.functionIds.length}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {node && (
                <div className="extraction-inspector">
                  <h3>{node.name}</h3>
                  {node.evidence.map((e, i) => (
                    <button
                      className="text-button"
                      key={i}
                      onClick={() =>
                        setSource({
                          title: `${result.documents.find((d) => d.id === e.documentId)?.title}, ${e.locator}`,
                          quote: e.quote,
                        })
                      }
                    >
                      Clause {e.locator}
                    </button>
                  ))}
                  <ul>
                    {result.graph.edges
                      .filter((e) => e.source === node.id || e.target === node.id)
                      .map((e) => (
                        <li key={e.id}>
                          {result.graph.nodes.find((n) => n.id === e.source)?.name}{' '}
                          <strong>{e.type.replaceAll('_', ' ')}</strong>{' '}
                          {result.graph.nodes.find((n) => n.id === e.target)?.name}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {tab === 'functions' && (
            <div className="extracted-functions">
              {result.functions
                .filter((f) =>
                  `${f.description} ${f.canonical.object}`.toLowerCase().includes(search.toLowerCase()),
                )
                .map((f) => (
                  <details key={f.id}>
                    <summary>
                      <span className="muted">{f.evidence[0].locator}</span>
                      <span>{f.description}</span>
                    </summary>
                    <div>
                      <p>
                        <strong>Owner: </strong>
                        {f.ownerIds
                          .map((id) => result.graph.nodes.find((n) => n.id === id)?.name ?? id)
                          .join(', ') || 'Unresolved'}
                      </p>
                      <p>{f.uncertainties.join(' ')}</p>
                      <pre>{JSON.stringify({ canonical: f.canonical, context: f.context }, null, 2)}</pre>
                      {f.evidence.map((e, i) => (
                        <button
                          key={i}
                          className="text-button"
                          onClick={() =>
                            setSource({ title: `${e.documentId}, ${e.locator}`, quote: e.quote })
                          }
                        >
                          Clause {e.locator}
                        </button>
                      ))}
                    </div>
                  </details>
                ))}
            </div>
          )}
          {tab === 'issues' && (
            <div className="extraction-issues">
              {result.issues
                .filter((i) => `${i.code} ${i.message}`.toLowerCase().includes(search.toLowerCase()))
                .map((issue) => (
                  <article key={issue.id}>
                    <strong>{issue.code.replaceAll('_', ' ')}</strong>
                    <span className="muted">{issue.severity}</span>
                    <p>{issue.message}</p>
                    {issue.evidence.map((e, i) => (
                      <button
                        className="text-button"
                        key={i}
                        onClick={() => setSource({ title: `${e.documentId}, ${e.locator}`, quote: e.quote })}
                      >
                        Clause {e.locator}
                      </button>
                    ))}
                  </article>
                ))}
            </div>
          )}
          {tab === 'json' && (
            <>
              <label className="field-label" htmlFor="extraction-json">
                Graph and function JSON
              </label>
              <textarea
                id="extraction-json"
                className="code-editor"
                rows={22}
                spellCheck={false}
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
              <button className="button secondary" onClick={applyEdits}>
                <FileJson2 size={16} />
                Apply draft
              </button>
            </>
          )}
          {source && (
            <aside className="extraction-source">
              <div className="document-commandbar">
                <strong>{source.title}</strong>
                <button className="text-button" onClick={() => setSource(null)}>
                  Close
                </button>
              </div>
              <blockquote>{source.quote}</blockquote>
            </aside>
          )}
          <details className="extraction-trace">
            <summary>Execution trace ({result.trace.length})</summary>
            <ol>
              {result.trace.map((event, i) => (
                <li key={i}>
                  <strong>
                    {event.stage}: {event.action}
                  </strong>
                  <p>{event.detail}</p>
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
    </div>
  );
}
