import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck, BrainCircuit, Terminal, CloudLightning, Monitor,
  FileText, Upload, X, CheckCircle, XCircle, Clock,
  ChevronDown, ChevronUp, Layers, Briefcase, DollarSign,
  HeartPulse, ChevronRight, AlertTriangle, Download, Eye
} from 'lucide-react';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ── DOMAIN PRESETS ───────────────────────────────────────────────────────────
const DOMAINS = [
  {
    key: 'job',
    label: 'Job Selection',
    sub: 'CV Analysis',
    Icon: Briefcase,
    color: '#6366f1',
    task_type: 'Job Selection (CV Analysis)',
    sensitive_attrs: 'Gender, Race, Age, Employment Gap, Educational Institution',
    criteria: 'Minimum 4 years relevant experience, demonstrated leadership skills, ability to explain employment gaps exceeding 3 months.',
    system_prompt:
      'You are an expert, unbiased HR recruitment specialist performing CV shortlisting. Evaluate candidates ONLY on measurable skills, relevant experience, technical qualifications, and role-specific achievements. NEVER factor in gender, race, age, nationality, school prestige, or personal circumstances unrelated to job performance. Flag anything that could introduce bias.',
    placeholder: 'Paste CV text, applicant summary, or job application details here...',
    batchLabel: 'Batch CVs',
    batchFileHint: '.pdf · .docx · .txt',
    batchRunLabel: 'CVs'
  },
  {
    key: 'loan',
    label: 'Loan Provision',
    sub: 'Financial Profile',
    Icon: DollarSign,
    color: '#10b981',
    task_type: 'Loan Provision (Financial Profile)',
    sensitive_attrs: 'Race, Gender, Marital Status, Nationality, Zip Code, Religion',
    criteria: 'Minimum credit score 650, stable verifiable income for 2+ years, debt-to-income ratio below 43%, adequate collateral or guarantor.',
    system_prompt:
      'You are an expert, unbiased financial analyst evaluating loan applications. Assess ONLY on objective financial metrics: credit score, income stability, debt-to-income ratio, repayment history, employment duration, and collateral value. NEVER allow race, gender, marital status, nationality, residential ZIP code, or religion to influence the credit decision. Base every recommendation on quantifiable financial data only.',
    placeholder: 'Paste financial profile, credit history, income details, or loan application here...',
    batchLabel: 'Batch Applications',
    batchFileHint: '.pdf · .docx · .txt',
    batchRunLabel: 'Applications'
  },
  {
    key: 'medical',
    label: 'Medical Care',
    sub: 'Patient Data',
    Icon: HeartPulse,
    color: '#ef4444',
    task_type: 'Medical Care (Patient Data)',
    sensitive_attrs: 'Race, Gender, Age, Socioeconomic Status, Insurance Type, Language, Disability',
    criteria: 'Base treatment on clinical symptoms, evidence-based guidelines, lab results, and patient history only. Equal standard of care for all patients.',
    system_prompt:
      'You are an expert, unbiased medical professional evaluating patient cases for diagnosis and treatment recommendations. Base ALL assessments purely on clinical symptoms, objective test results, medical history, and evidence-based clinical guidelines. NEVER allow race, gender, age, insurance coverage, socioeconomic background, disability status, or language barriers to influence the standard of care or treatment. Every patient deserves equal, evidence-based medical attention.',
    placeholder: 'Paste patient medical history, presenting symptoms, lab results, and clinical data here...',
    batchLabel: 'Batch Records',
    batchFileHint: '.pdf · .docx · .txt',
    batchRunLabel: 'Records'
  }
];

// ── HELPERS ──────────────────────────────────────────────────────────────────
const parseVerdict = (text) => {
  if (!text) return 'review';
  const t = text.toLowerCase();
  const rejectPhrases = [
    'reject', 'not selected', 'not recommended', 'declined', 'disqualified',
    'does not meet', 'insufficient', 'unsuitable', 'not suitable', 'not qualify',
    'below requirements', 'not shortlisted', 'cannot recommend', 'do not recommend'
  ];
  const acceptPhrases = [
    'accept', 'selected', 'recommended', 'shortlist', 'hire', 'qualified',
    'strong candidate', 'strong contender', 'approve', 'approved', 'proceed',
    'invite for interview', 'move forward', 'advance'
  ];
  if (rejectPhrases.some(w => t.includes(w))) return 'rejected';
  if (acceptPhrases.some(w => t.includes(w))) return 'accepted';
  return 'review';
};

const extractReason = (text) => {
  if (!text) return '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      lower.includes('verdict') || lower.includes('recommendation') ||
      lower.includes('decision') || lower.includes('overall') ||
      lower.includes('conclusion') || lower.includes('summary')
    ) {
      const clean = line.replace(/\*+/g, '').replace(/^[-•:#]+\s*/, '').trim();
      if (clean.length > 10 && clean.length < 250) return clean;
    }
  }
  const first = lines.find(l => l.length > 20 && !l.startsWith('#') && !l.startsWith('*'));
  return first ? first.replace(/\*+/g, '').substring(0, 160) + (first.length > 160 ? '...' : '') : '';
};

const exportToFile = (cvItems, filename) => {
  const content = cvItems
    .map(cv => `=== ${cv.filename} ===\n${cv.result || 'No result'}\n`)
    .join('\n' + '─'.repeat(60) + '\n\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

// ── MAIN APP ─────────────────────────────────────────────────────────────────
function App() {
  const [mode, setMode] = useState('manual');
  const [activeDomain, setActiveDomain] = useState(DOMAINS[0]);

  const [formData, setFormData] = useState({
    input_data: DOMAINS[0].placeholder,
    sensitive_attrs: DOMAINS[0].sensitive_attrs,
    criteria: DOMAINS[0].criteria,
    system_prompt: DOMAINS[0].system_prompt
  });
  const [showPrompt, setShowPrompt] = useState(false);

  // Manual mode
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState('idle');
  const [currentStep, setCurrentStep] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [penalties, setPenalties] = useState(0);
  const [finalResult, setFinalResult] = useState('');
  const [loopActive, setLoopActive] = useState(false);
  const [auditorSource, setAuditorSource] = useState('Local');
  const logEndRef = useRef(null);

  // Batch mode
  const [cvList, setCvList] = useState([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [expandedCv, setExpandedCv] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [workflowCv, setWorkflowCv] = useState(null);
  const [skipMeta, setSkipMeta] = useState(false);
  const [useSearch, setUseSearch] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // ── Domain switch — clears CV queue ──
  const handleDomainChange = (domain) => {
    setActiveDomain(domain);
    setFormData(prev => ({
      ...prev,
      sensitive_attrs: domain.sensitive_attrs,
      criteria: domain.criteria,
      system_prompt: domain.system_prompt,
      input_data: DOMAINS.some(d => d.placeholder === prev.input_data)
        ? domain.placeholder
        : prev.input_data
    }));
    setFinalResult('');
    setLogs([]);
    setStatus('idle');
    // Auto-clear pending queue when domain changes
    setCvList(prev => prev.filter(c => c.status === 'complete' || c.status === 'error'));
  };

  const addLog = (msg, type = 'info', extra = null) =>
    setLogs(prev => [...prev, { msg, type, extra, id: Date.now() + Math.random() }]);

  // ── Manual run ──
  const handleRun = () => {
    setLogs([]);
    setStatus('processing');
    setFinalResult('');
    setAttempt(0);
    setPenalties(0);
    setLoopActive(false);
    setAuditorSource('Local');

    const params = new URLSearchParams({
      input_data: formData.input_data,
      task_type: activeDomain.task_type,
      sensitive_attrs: formData.sensitive_attrs,
      criteria: formData.criteria,
      system_prompt: formData.system_prompt,
      skip_meta: skipMeta,
      use_search: useSearch
    });
    const eventSource = new EventSource(`${API}/process?${params}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.event) {
        case 'status': addLog(data.data); break;
        case 'rag_complete':
          setCurrentStep('rag');
          addLog(`RAG Context: ${data.data}`, 'success');
          break;
        case 'attempt_start':
          setAttempt(data.data.attempt);
          addLog(`Starting Attempt #${data.data.attempt}...`);
          setLoopActive(false);
          break;
        case 'predictor_start': setCurrentStep('predictor'); break;
        case 'predictor_end':
          addLog('Draft generated by Predictor.', 'success', { thoughts: data.data.thoughts });
          break;
        case 'audit_start': setCurrentStep('auditor'); break;
        case 'audit_end': {
          const { is_biased, reason, score, thoughts, source } = data.data;
          setAuditorSource(source || 'Local');
          addLog(
            is_biased
              ? `[${source}] BIAS DETECTED! Score: ${score}/10. Reason: ${reason}`
              : `[${source}] Audit passed. Score: ${score}/10.`,
            is_biased ? 'error' : 'success',
            { thoughts }
          );
          break;
        }
        case 'meta_skipped': addLog('Meta-Auditor skipped — Speed Mode active.', 'penalty'); break;
        case 'meta_start': setCurrentStep('meta'); break;
        case 'meta_end':
          addLog(
            data.data.is_valid ? 'Audit Validated.' : 'Audit Rejected.',
            data.data.is_valid ? 'success' : 'error',
            { thoughts: data.data.thoughts }
          );
          break;
        case 'penalty':
          setPenalties(prev => prev + 1);
          setLoopActive(true);
          addLog(`Penalty Applied: ${data.data.reason}`, 'penalty');
          break;
        case 'final_result':
          setFinalResult(data.data);
          setStatus('complete');
          setCurrentStep(null);
          eventSource.close();
          break;
        case 'error':
          addLog(`Error: ${data.data}`, 'error');
          setStatus('error');
          eventSource.close();
          break;
        default: break;
      }
    };
  };

  // ── Batch file upload — with dedup ──
  const handleFiles = async (files) => {
    setUploadError('');
    const valid = Array.from(files).filter(f => /\.(pdf|docx|txt)$/i.test(f.name));
    if (!valid.length) {
      setUploadError('Only .pdf, .docx, and .txt files are supported.');
      return;
    }
    const fd = new FormData();
    valid.forEach(f => fd.append('files', f));
    setIsUploading(true);
    try {
      const res = await fetch('${API}/extract-cvs', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const extracted = await res.json();
      setCvList(prev => {
        const existingNames = new Set(prev.map(c => c.filename));
        const newCvs = extracted.filter(cv => !existingNames.has(cv.filename));
        const dupCount = extracted.length - newCvs.length;
        if (dupCount > 0)
          setUploadError(`${dupCount} duplicate${dupCount > 1 ? 's' : ''} skipped.`);
        return [
          ...prev,
          ...newCvs.map(cv => ({
            id: Date.now() + Math.random(),
            filename: cv.filename,
            text: cv.text,
            charCount: cv.text.length,
            status: 'pending',
            result: null,
            verdict: null,
            reason: '',
            logs: []
          }))
        ];
      });
    } catch (e) {
      setUploadError(`Upload failed: ${e.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const removeCv = (id) => setCvList(prev => prev.filter(c => c.id !== id));
  const clearAll = () => { setCvList([]); setExpandedCv(null); };

  // ── Batch run — captures logs per CV, removes from queue on complete ──
  const runBatch = async () => {
    setBatchRunning(true);
    const snapshot = cvList.filter(c => c.status === 'pending');
    for (const cv of snapshot) {
      await new Promise((resolve) => {
        setCvList(prev => prev.map(c => c.id === cv.id ? { ...c, status: 'processing' } : c));
        const params = new URLSearchParams({
          input_data: cv.text,
          task_type: activeDomain.task_type,
          sensitive_attrs: formData.sensitive_attrs,
          criteria: formData.criteria,
          system_prompt: formData.system_prompt,
          skip_meta: skipMeta,
          use_search: useSearch
        });
        const es = new EventSource(`${API}/process?${params}`);
        const cvLogs = [];
        es.onmessage = (e) => {
          const p = JSON.parse(e.data);
          cvLogs.push(p);
          if (p.event === 'final_result') {
            setCvList(prev => prev.map(c => c.id === cv.id ? {
              ...c,
              status: 'complete',
              result: p.data,
              verdict: parseVerdict(p.data),
              reason: extractReason(p.data),
              logs: [...cvLogs]
            } : c));
            es.close(); resolve();
          } else if (p.event === 'error') {
            setCvList(prev => prev.map(c => c.id === cv.id ? {
              ...c,
              status: 'error',
              result: p.data,
              verdict: 'error',
              logs: [...cvLogs]
            } : c));
            es.close(); resolve();
          }
        };
        es.onerror = () => {
          setCvList(prev => prev.map(c => c.id === cv.id ? {
            ...c, status: 'error', result: 'Connection failed', verdict: 'error', logs: cvLogs
          } : c));
          es.close(); resolve();
        };
      });
    }
    setBatchRunning(false);
  };

  // Derived lists
  const queueList     = cvList.filter(c => c.status === 'pending' || c.status === 'processing');
  const acceptedCvs   = cvList.filter(c => c.status === 'complete' && c.verdict === 'accepted');
  const rejectedCvs   = cvList.filter(c => c.status === 'complete' && c.verdict === 'rejected');
  const reviewCvs     = cvList.filter(c => c.status === 'complete' && c.verdict === 'review');
  const errorCvs      = cvList.filter(c => c.status === 'error');
  const processingIdx = cvList.findIndex(c => c.status === 'processing');

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* Workflow Modal */}
      <AnimatePresence>
        {workflowCv && (
          <WorkflowModal cv={workflowCv} onClose={() => setWorkflowCv(null)} accentColor={activeDomain.color} />
        )}
      </AnimatePresence>

      {/* ── SIDEBAR ── */}
      <aside className="sidebar">
        <h1>BiasModel v2.5</h1>

        <div className="domain-section">
          <label>Analysis Domain</label>
          <div className="domain-cards">
            {DOMAINS.map(d => (
              <button
                key={d.key}
                className={`domain-card ${activeDomain.key === d.key ? 'active' : ''}`}
                style={activeDomain.key === d.key ? { '--dc': d.color } : {}}
                onClick={() => handleDomainChange(d)}
              >
                <d.Icon size={16} />
                <div className="domain-card-text">
                  <span className="domain-card-name">{d.label}</span>
                  <span className="domain-card-sub">{d.sub}</span>
                </div>
                {activeDomain.key === d.key && <ChevronRight size={12} className="domain-check" />}
              </button>
            ))}
          </div>
        </div>

        <div className="mode-tabs">
          <button className={`mode-tab ${mode === 'manual' ? 'active' : ''}`} onClick={() => setMode('manual')}>
            <BrainCircuit size={13} /> Manual
          </button>
          <button className={`mode-tab ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>
            <Layers size={13} /> {activeDomain.batchLabel}
          </button>
        </div>

        {mode === 'manual' ? (
          <>
            <div className="form-group">
              <label>Input Data</label>
              <textarea
                rows={5}
                value={formData.input_data}
                placeholder={activeDomain.placeholder}
                onChange={e => setFormData({ ...formData, input_data: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Sensitive Attributes</label>
              <input
                value={formData.sensitive_attrs}
                onChange={e => setFormData({ ...formData, sensitive_attrs: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Evaluation Criteria</label>
              <textarea
                rows={3}
                value={formData.criteria}
                onChange={e => setFormData({ ...formData, criteria: e.target.value })}
              />
            </div>

            <div className="prompt-accordion">
              <button className="prompt-toggle" onClick={() => setShowPrompt(p => !p)}>
                <span>AI System Prompt</span>
                {showPrompt ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              <AnimatePresence initial={false}>
                {showPrompt && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ overflow: 'hidden' }}
                  >
                    <textarea
                      className="prompt-textarea"
                      rows={6}
                      value={formData.system_prompt}
                      onChange={e => setFormData({ ...formData, system_prompt: e.target.value })}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <MetaToggle skipMeta={skipMeta} setSkipMeta={setSkipMeta} count={1} />
            <SearchToggle useSearch={useSearch} setUseSearch={setUseSearch} />

            <button className="run-btn" style={{ '--rb': activeDomain.color }} onClick={handleRun} disabled={status === 'processing'}>
              {status === 'processing' ? 'Processing...' : `Run ${activeDomain.label} Pipeline`}
            </button>
          </>
        ) : (
          <>
            <div
              className={`drop-zone ${isDragOver ? 'drag-over' : ''} ${isUploading ? 'uploading' : ''}`}
              onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={e => { e.preventDefault(); setIsDragOver(false); handleFiles(e.dataTransfer.files); }}
              onClick={() => !isUploading && fileInputRef.current?.click()}
            >
              {isUploading ? (
                <>
                  <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
                    <BrainCircuit size={26} color="var(--accent)" />
                  </motion.div>
                  <span style={{ color: 'var(--accent)' }}>Extracting & Uploading {fileInputRef.current?.files?.length || ''} files...</span>
                </>
              ) : (
                <>
                  <Upload size={26} />
                  <span>Drop files here or click to browse</span>
                  <small>{activeDomain.batchFileHint}</small>
                </>
              )}
              <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx,.txt"
                style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
            </div>

            {uploadError && (
              <div className="upload-error"><AlertTriangle size={13} /> {uploadError}</div>
            )}

            {/* Queue — only pending/processing */}
            {queueList.length > 0 && (
              <div className="cv-list">
                <div className="cv-list-header">
                  <span>{queueList.length} in queue</span>
                  <button className="clear-btn" onClick={clearAll} disabled={batchRunning}>Clear all</button>
                </div>
                {queueList.map(cv => (
                  <div key={cv.id} className={`cv-item status-${cv.status}`}>
                    <FileText size={12} />
                    <span className="cv-filename" title={cv.filename}>{cv.filename}</span>
                    <span className="cv-chars">{(cv.charCount / 1000).toFixed(1)}k</span>
                    <button className="remove-cv-btn" onClick={() => removeCv(cv.id)}
                      disabled={cv.status === 'processing' || batchRunning}><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}

            <div className="form-group">
              <label>Sensitive Attributes</label>
              <input value={formData.sensitive_attrs}
                onChange={e => setFormData({ ...formData, sensitive_attrs: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Evaluation Criteria</label>
              <textarea rows={3} value={formData.criteria}
                onChange={e => setFormData({ ...formData, criteria: e.target.value })} />
            </div>

            <MetaToggle skipMeta={skipMeta} setSkipMeta={setSkipMeta} count={queueList.length} />
            <SearchToggle useSearch={useSearch} setUseSearch={setUseSearch} />

            <button className="run-btn" style={{ '--rb': activeDomain.color }}
              onClick={runBatch} disabled={batchRunning || !queueList.length}>
              {batchRunning
                ? `Processing ${processingIdx + 1}/${cvList.length}...`
                : `Run ${queueList.length || ''} ${activeDomain.batchRunLabel} — ${activeDomain.label}`}
            </button>
          </>
        )}

        <div className="model-status">
          <div className="model-dot"><div className="dot green" />Local: Gemma-3</div>
          <div className="model-dot"><div className="dot amber" />Cloud: Gemini 2.5 Flash</div>
        </div>
      </aside>

      {/* ── MAIN VIEW ── */}
      <main className="main-view">
        <div className="domain-banner" style={{ '--db': activeDomain.color }}>
          <activeDomain.Icon size={18} />
          <span>{activeDomain.task_type}</span>
        </div>

        {mode === 'manual' ? (
          <>
            <section className={`pipeline-viz ${loopActive ? 'loop-active' : ''}`}>
              <div className="loop-arrow" />
              <StepBox title="Predictor" active={currentStep === 'predictor'}
                icon={<BrainCircuit size={20} />}
                status={status === 'processing' && currentStep === 'predictor' ? 'Thinking...' : 'Gemma-3'}
                penaltyCount={penalties} accentColor={activeDomain.color} />
              <Connector active={currentStep === 'auditor' || currentStep === 'meta'} color={activeDomain.color} />
              <StepBox
                title={auditorSource === 'Local' ? 'Local Auditor' : 'Supreme Auditor'}
                active={currentStep === 'auditor'}
                icon={auditorSource === 'Local' ? <Monitor size={20} /> : <CloudLightning size={20} color="var(--accent)" />}
                status={status === 'processing' && currentStep === 'auditor' ? 'Auditing...' : auditorSource}
                highlight={auditorSource !== 'Local'} accentColor={activeDomain.color} />
              <Connector active={status === 'complete'} color={activeDomain.color} />
              <StepBox title="Final Output" active={status === 'complete'}
                icon={<ShieldCheck size={20} />}
                status={status === 'complete' ? 'Unbiased ✓' : 'Waiting...'}
                accentColor={activeDomain.color} />
            </section>

            <section className="console">
              <div className="console-title">
                <Terminal size={15} />
                <span>LIVE PIPELINE LOGS {attempt > 0 && `— ATTEMPT #${attempt}`}</span>
              </div>
              {logs.map(log => (
                <div key={log.id} className={`log-entry ${log.type}`}>
                  <div>{log.msg}</div>
                  {log.extra?.thoughts && (
                    <div className="thinking-block">
                      <strong>Internal Logic:</strong><br />{log.extra.thoughts}
                    </div>
                  )}
                </div>
              ))}
              <div ref={logEndRef} />
            </section>

            {finalResult && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="final-result" style={{ borderColor: activeDomain.color }}>
                <h2 className="final-result-title" style={{ color: activeDomain.color }}>
                  <ShieldCheck /> FINAL UNBIASED OUTPUT — {activeDomain.label.toUpperCase()}
                </h2>
                {finalResult}
              </motion.div>
            )}
          </>
        ) : (
          /* ── BATCH VIEW ── */
          cvList.length === 0 && queueList.length === 0 ? (
            <div className="batch-empty">
              <activeDomain.Icon size={52} style={{ color: activeDomain.color, opacity: 0.35 }} />
              <p>Upload files in the sidebar to begin batch processing.</p>
              <small>Active domain: <strong>{activeDomain.label}</strong> — {activeDomain.sub}</small>
            </div>
          ) : (
            <>
              {/* Stats */}
              <div className="batch-stats">
                <StatCard label="Total"    value={cvList.length} />
                <StatCard label="Selected" value={acceptedCvs.length} color="#10b981" />
                <StatCard label="Rejected" value={rejectedCvs.length} color="var(--error)" />
                <StatCard label="Review"   value={reviewCvs.length}   color="var(--accent)" />
                <StatCard label="Queue"    value={queueList.length}   color="var(--text-dim)" />
                {batchRunning && processingIdx !== -1 && (
                  <div className="processing-label">
                    <motion.span animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 1.2, repeat: Infinity }}>
                      Processing {processingIdx + 1}/{cvList.length}
                    </motion.span>
                  </div>
                )}
              </div>

              {/* Selected Section */}
              {acceptedCvs.length > 0 && (
                <ResultSection
                  title="Selected"
                  color="#10b981"
                  icon={<CheckCircle size={16} />}
                  cvs={acceptedCvs}
                  expandedCv={expandedCv}
                  setExpandedCv={setExpandedCv}
                  setWorkflowCv={setWorkflowCv}
                  accentColor="#10b981"
                  onExport={() => exportToFile(acceptedCvs, `selected_${activeDomain.key}.txt`)}
                />
              )}

              {/* Rejected Section */}
              {rejectedCvs.length > 0 && (
                <ResultSection
                  title="Not Selected"
                  color="var(--error)"
                  icon={<XCircle size={16} />}
                  cvs={rejectedCvs}
                  expandedCv={expandedCv}
                  setExpandedCv={setExpandedCv}
                  setWorkflowCv={setWorkflowCv}
                  accentColor="var(--error)"
                  onExport={() => exportToFile(rejectedCvs, `rejected_${activeDomain.key}.txt`)}
                />
              )}

              {/* Review Section */}
              {reviewCvs.length > 0 && (
                <ResultSection
                  title="Needs Review"
                  color="var(--accent)"
                  icon={<AlertTriangle size={16} />}
                  cvs={reviewCvs}
                  expandedCv={expandedCv}
                  setExpandedCv={setExpandedCv}
                  setWorkflowCv={setWorkflowCv}
                  accentColor="var(--accent)"
                  onExport={() => exportToFile(reviewCvs, `review_${activeDomain.key}.txt`)}
                />
              )}

              {/* Error Section */}
              {errorCvs.length > 0 && (
                <ResultSection
                  title="Errors"
                  color="#475569"
                  icon={<XCircle size={16} />}
                  cvs={errorCvs}
                  expandedCv={expandedCv}
                  setExpandedCv={setExpandedCv}
                  setWorkflowCv={setWorkflowCv}
                  accentColor="#475569"
                  onExport={null}
                />
              )}

              {/* Processing / pending placeholders */}
              {queueList.length > 0 && (
                <div className="result-section">
                  <div className="result-section-header" style={{ color: 'var(--primary)' }}>
                    <motion.div animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 1.2, repeat: Infinity }} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <BrainCircuit size={16} />
                      <span>In Queue — {queueList.length} remaining</span>
                    </motion.div>
                  </div>
                  <div className="cv-results-grid">
                    {queueList.map(cv => (
                      <CvResultCard key={cv.id} cv={cv} expanded={false}
                        accentColor={activeDomain.color} onToggle={() => {}} onWorkflow={null} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )
        )}
      </main>
    </div>
  );
}

// ── RESULT SECTION ────────────────────────────────────────────────────────────
const ResultSection = ({ title, color, icon, cvs, expandedCv, setExpandedCv, setWorkflowCv, accentColor, onExport }) => (
  <div className="result-section">
    <div className="result-section-header" style={{ color }}>
      {icon}
      <span>{title} ({cvs.length})</span>
      {onExport && (
        <button className="export-btn" onClick={onExport} title={`Download ${title} as .txt`}>
          <Download size={13} /> Export
        </button>
      )}
    </div>
    <div className="cv-results-grid">
      {cvs.map(cv => (
        <CvResultCard
          key={cv.id}
          cv={cv}
          expanded={expandedCv === cv.id}
          accentColor={accentColor}
          onToggle={() => setExpandedCv(expandedCv === cv.id ? null : cv.id)}
          onWorkflow={() => setWorkflowCv(cv)}
        />
      ))}
    </div>
  </div>
);

// ── CV RESULT CARD ────────────────────────────────────────────────────────────
const CvResultCard = ({ cv, expanded, onToggle, accentColor, onWorkflow }) => {
  const verdictConfig = {
    accepted: { label: 'SELECTED',     color: '#10b981', icon: <CheckCircle size={14} /> },
    rejected: { label: 'NOT SELECTED', color: '#ef4444', icon: <XCircle size={14} />    },
    review:   { label: 'NEEDS REVIEW', color: '#f59e0b', icon: <AlertTriangle size={14} /> },
    error:    { label: 'ERROR',        color: '#475569', icon: <XCircle size={14} />    },
  };
  const vc = verdictConfig[cv.verdict] || null;

  const spinIcon = (
    <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} style={{ display: 'flex' }}>
      <BrainCircuit size={15} color={accentColor} />
    </motion.div>
  );

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className={`cv-result-card status-${cv.status} ${cv.verdict ? `verdict-${cv.verdict}` : ''}`}>

      {/* Header */}
      <div className="cv-result-header" onClick={cv.result ? onToggle : undefined}
        style={{ cursor: cv.result ? 'pointer' : 'default' }}>
        <div className="cv-result-meta">
          {cv.status === 'processing' ? spinIcon
            : cv.status === 'pending'   ? <Clock size={15} color="var(--text-dim)" />
            : cv.status === 'complete'  ? (vc ? React.cloneElement(vc.icon, { color: vc.color }) : <CheckCircle size={15} color={accentColor} />)
            : <XCircle size={15} color="var(--error)" />}
          <div>
            <div className="cv-result-filename" title={cv.filename}>{cv.filename}</div>
            {vc ? (
              <div className="verdict-badge" style={{ color: vc.color, borderColor: vc.color + '44', background: vc.color + '14' }}>
                {vc.label}
              </div>
            ) : (
              <div className="cv-result-badge" style={{ color: cv.status === 'processing' ? accentColor : 'var(--text-dim)' }}>
                {cv.status.charAt(0).toUpperCase() + cv.status.slice(1)}
              </div>
            )}
          </div>
        </div>
        <div className="card-actions">
          {onWorkflow && cv.logs?.length > 0 && (
            <button className="workflow-btn" onClick={e => { e.stopPropagation(); onWorkflow(); }} title="View full pipeline workflow">
              <Eye size={13} />
            </button>
          )}
          {cv.result && <span className="expand-btn">{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>}
        </div>
      </div>

      {/* Reason snippet */}
      {cv.reason && !expanded && (
        <div className="cv-result-reason" onClick={onToggle} style={{ cursor: 'pointer' }}>
          {cv.reason}
        </div>
      )}

      {/* Processing bar */}
      {cv.status === 'processing' && (
        <div className="cv-processing-track">
          <motion.div className="cv-processing-fill" style={{ background: accentColor }}
            animate={{ x: ['-100%', '100%'] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} />
        </div>
      )}

      {/* Expanded result */}
      <AnimatePresence initial={false}>
        {expanded && cv.result && (
          <motion.div key="body"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }}
            className="cv-result-body">
            {cv.result}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

// ── WORKFLOW MODAL ────────────────────────────────────────────────────────────
const WorkflowModal = ({ cv, onClose, accentColor }) => {
  const renderLog = (event, idx) => {
    let msg = '', type = 'info', thoughts = null;
    switch (event.event) {
      case 'status':         msg = event.data; break;
      case 'rag_complete':   msg = `RAG Context: ${event.data}`; type = 'success'; break;
      case 'attempt_start':  msg = `Starting Attempt #${event.data.attempt}...`; break;
      case 'predictor_start': msg = 'Predictor (Gemma) thinking...'; break;
      case 'predictor_end':
        msg = 'Draft generated by Predictor.';
        type = 'success';
        thoughts = event.data.thoughts;
        break;
      case 'audit_start':    msg = 'Local Auditor checking for bias...'; break;
      case 'audit_end': {
        const { is_biased, reason, score, source } = event.data;
        msg = is_biased
          ? `[${source}] BIAS DETECTED! Score: ${score}/10. Reason: ${reason}`
          : `[${source}] Audit passed. Score: ${score}/10.`;
        type = is_biased ? 'error' : 'success';
        thoughts = event.data.thoughts;
        break;
      }
      case 'meta_start':  msg = 'Meta-Auditor verifying audit logic...'; break;
      case 'meta_end':
        msg = event.data.is_valid ? 'Audit Validated.' : 'Audit Rejected.';
        type = event.data.is_valid ? 'success' : 'error';
        thoughts = event.data.thoughts;
        break;
      case 'penalty':  msg = `Penalty Applied: ${event.data.reason}`; type = 'penalty'; break;
      case 'final_result': msg = '✓ Final result generated.'; type = 'success'; break;
      case 'error':    msg = `Error: ${event.data}`; type = 'error'; break;
      default: return null;
    }
    return (
      <div key={idx} className={`log-entry ${type}`}>
        <div>{msg}</div>
        {thoughts && (
          <div className="thinking-block">
            <strong>Internal Logic:</strong><br />{thoughts}
          </div>
        )}
      </div>
    );
  };

  return (
    <motion.div className="modal-overlay"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}>
      <motion.div className="modal-panel"
        initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
        transition={{ duration: 0.22 }}
        onClick={e => e.stopPropagation()}>

        <div className="modal-header" style={{ borderColor: accentColor }}>
          <div>
            <div className="modal-title"><Terminal size={16} /> Pipeline Workflow</div>
            <div className="modal-subtitle">{cv.filename}</div>
          </div>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="modal-body">
          <div className="console" style={{ height: '320px', marginBottom: '1rem' }}>
            <div className="console-title">
              <Terminal size={13} /> <span>PIPELINE LOGS</span>
            </div>
            {cv.logs.map((e, i) => renderLog(e, i))}
          </div>

          {cv.result && (
            <div className="modal-result" style={{ borderColor: accentColor }}>
              <div className="modal-result-title" style={{ color: accentColor }}>
                <ShieldCheck size={14} /> FINAL OUTPUT
              </div>
              <div className="modal-result-body">{cv.result}</div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

// ── SHARED SUB-COMPONENTS ─────────────────────────────────────────────────────
const StatCard = ({ label, value, color }) => (
  <div className="stat-card">
    <span className="stat-value" style={color ? { color } : {}}>{value}</span>
    <span className="stat-label">{label}</span>
  </div>
);

const StepBox = ({ title, active, icon, status, penaltyCount, highlight, accentColor }) => (
  <motion.div
    className={`box ${active ? 'active' : ''}`}
    style={active && !highlight ? { borderColor: accentColor, boxShadow: `0 0 20px ${accentColor}44` }
         : highlight ? { borderColor: 'var(--accent)', boxShadow: '0 0 20px rgba(245,158,11,0.2)' }
         : {}}
    animate={active ? { scale: 1.05 } : { scale: 1 }}
  >
    {penaltyCount > 0 && <div className="penalty-badge">PENALTY x{penaltyCount}</div>}
    <div style={{ color: active ? (highlight ? 'var(--accent)' : accentColor) : 'var(--text-dim)', marginBottom: '0.5rem' }}>
      {icon}
    </div>
    <h3 style={highlight ? { color: 'var(--accent)' } : active ? { color: accentColor } : {}}>{title}</h3>
    <div className="status">{status}</div>
  </motion.div>
);

const MetaToggle = ({ skipMeta, setSkipMeta, count }) => {
  const showWarning = count >= 10 && !skipMeta;
  return (
    <div className={`meta-toggle-box ${skipMeta ? 'speed-mode' : ''}`}>
      <div className="meta-toggle-row">
        <div className="meta-toggle-label">
          <span className="meta-toggle-title">Meta-Auditor</span>
          <span className="meta-toggle-sub">{skipMeta ? 'Disabled — Speed Mode' : 'Enabled — Accuracy Mode'}</span>
        </div>
        <button
          className={`toggle-switch ${skipMeta ? 'off' : 'on'}`}
          onClick={() => setSkipMeta(p => !p)}
          title="Toggle Meta-Auditor"
        >
          <motion.div className="toggle-thumb" layout transition={{ duration: 0.2 }} />
        </button>
      </div>
      <AnimatePresence>
        {skipMeta && (
          <motion.div className="meta-warning speed"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
            <AlertTriangle size={11} />
            Speed Mode: skips Meta-Auditor verification. Faster but may reduce accuracy.
          </motion.div>
        )}
        {showWarning && (
          <motion.div className="meta-warning bulk"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
            <AlertTriangle size={11} />
            {count} files detected — consider enabling Speed Mode for faster processing.
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const SearchToggle = ({ useSearch, setUseSearch }) => {
  return (
    <div className={`meta-toggle-box ${!useSearch ? 'speed-mode' : ''}`}>
      <div className="meta-toggle-row">
        <div className="meta-toggle-label">
          <span className="meta-toggle-title">Web Search (RAG)</span>
          <span className="meta-toggle-sub">{useSearch ? 'Enabled — AI decides if needed' : 'Disabled — Full Offline Mode'}</span>
        </div>
        <button
          className={`toggle-switch ${!useSearch ? 'off' : 'on'}`}
          onClick={() => setUseSearch(p => !p)}
          title="Toggle Web Search"
        >
          <motion.div className="toggle-thumb" layout transition={{ duration: 0.2 }} />
        </button>
      </div>
    </div>
  );
};

const Connector = ({ active, color }) => (
  <div className="connector">
    {active && (
      <motion.div className="particle" style={{ background: color, boxShadow: `0 0 10px ${color}` }}
        animate={{ left: ['0%', '100%'] }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
    )}
  </div>
);

export default App;
