import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { MapPin, X, Camera, Video, Loader, Upload, AlertTriangle, Sparkles, Mail, Pencil, Check, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { issueAPI } from '../services/api';
import toast from 'react-hot-toast';

// Fix leaflet default marker
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const SEVERITY_COLORS = {
  low:      { bg: '#f0fdf4', border: '#bbf7d0', text: '#166534' },
  medium:   { bg: '#fffbeb', border: '#fde68a', text: '#92400e' },
  high:     { bg: '#fff7ed', border: '#fed7aa', text: '#9a3412' },
  critical: { bg: '#fef2f2', border: '#fecaca', text: '#991b1b' }
};

export default function ReportIssue() {
  const { user } = useAuth();
  const navigate  = useNavigate();

  // ── Step machine: 'form' → 'preview' → (submitted, navigates away) ────────
  const [step, setStep] = useState('form');

  const [files,    setFiles]    = useState([]);
  const [previews, setPreviews] = useState([]);
  const [location, setLocation] = useState(null);   // { latitude, longitude }
  const [address,  setAddress]  = useState('');
  const [locLoading,  setLocLoading]  = useState(false);
  const [analyzing,   setAnalyzing]   = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [duplicate,   setDuplicate]   = useState(null); // 409 response (from either step)

  // The AI analysis preview returned by POST /api/issues/analyze.
  // Sent back, with assignedAuthority.email possibly edited, to POST /api/issues.
  const [analysis, setAnalysis] = useState(null);
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');

  // Guard: must be verified
  useEffect(() => {
    if (user && (!user.emailVerified || !user.aadhaarVerified)) {
      toast.error('Complete email and Aadhaar verification before reporting.');
      navigate('/verify');
    }
  }, [user, navigate]);

  // ── Media dropzone ──────────────────────────────────────────────────────────
  const onDrop = useCallback((accepted) => {
    const merged = [...files, ...accepted].slice(0, 3);
    setFiles(merged);
    setPreviews(merged.map(f => ({
      url:  URL.createObjectURL(f),
      type: f.type.startsWith('video/') ? 'video' : 'image',
      name: f.name
    })));
  }, [files]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp'], 'video/*': ['.mp4', '.mov', '.avi', '.webm'] },
    maxFiles: 3,
    maxSize: 50 * 1024 * 1024,
    disabled: step !== 'form'
  });

  const removeFile = (i) => {
    const f = files.filter((_, idx) => idx !== i);
    const p = previews.filter((_, idx) => idx !== i);
    setFiles(f);
    setPreviews(p);
  };

  // ── GPS location ────────────────────────────────────────────────────────────
  const getLocation = () => {
    if (!navigator.geolocation) return toast.error('Geolocation not supported by your browser.');
    setLocLoading(true);
    setDuplicate(null);
    navigator.geolocation.getCurrentPosition(
      async ({ coords: { latitude, longitude } }) => {
        setLocation({ latitude, longitude });
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`
          );
          const d = await r.json();
          setAddress(d.display_name || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
        } catch {
          setAddress(`${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
        }
        setLocLoading(false);
      },
      () => { setLocLoading(false); toast.error('Could not get location — please enable location access.'); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // ── STEP 1 → 2: "AI Analysis" button ───────────────────────────────────────
  const handleAnalyze = async () => {
    if (!files.length) return toast.error('Upload at least one photo or video.');
    if (!location)     return toast.error('Capture your location first.');

    setAnalyzing(true);
    setDuplicate(null);
    const tid = toast.loading('Analysing photos and identifying the responsible authority…');

    try {
      const formData = new FormData();
      files.forEach(f => formData.append('media', f));
      formData.append('latitude',  location.latitude);
      formData.append('longitude', location.longitude);
      formData.append('address',   address);

      const res = await issueAPI.analyze(formData);
      toast.dismiss(tid);

      if (res.data?.isDuplicate) {
        setDuplicate(res.data);
        toast.error('This issue has already been filed nearby.');
        return;
      }

      setAnalysis(res.data.analysis);
      setEmailDraft(res.data.analysis.assignedAuthority.email);
      setStep('preview');
      toast.success('Analysis complete — review before submitting.');

    } catch (err) {
      toast.dismiss(tid);
      if (err.response?.status === 409 && err.response.data?.isDuplicate) {
        setDuplicate(err.response.data);
        toast.error('This issue has already been filed nearby.');
      } else {
        toast.error(err.response?.data?.message || 'AI analysis failed. Please try again.');
      }
    } finally {
      setAnalyzing(false);
    }
  };

  // ── STEP 2: confirm edited authority email ─────────────────────────────────
  const saveEmailEdit = () => {
    const trimmed = emailDraft.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return toast.error('Enter a valid email address.');
    }
    setAnalysis(prev => ({
      ...prev,
      assignedAuthority: { ...prev.assignedAuthority, email: trimmed }
    }));
    setEditingEmail(false);
    toast.success('Authority email updated.');
  };

  // ── STEP 2 → submitted: "Submit Issue" button ───────────────────────────────
  const handleSubmit = async () => {
    if (!analysis) return toast.error('Please run AI Analysis first.');

    setSubmitting(true);
    setDuplicate(null);
    const tid = toast.loading('Submitting your report…');

    try {
      const res = await issueAPI.report({ analysis });
      toast.dismiss(tid);
      toast.success('Issue reported! 🎉');
      navigate(`/track/${res.data.issue.issueId}`);

    } catch (err) {
      toast.dismiss(tid);
      if (err.response?.status === 409 && err.response.data?.isDuplicate) {
        // Someone else filed the same issue between analyze and submit.
        setDuplicate(err.response.data);
        toast.error('This issue was just filed by someone else.');
      } else {
        toast.error(err.response?.data?.message || 'Submission failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const backToForm = () => {
    setStep('form');
    setAnalysis(null);
    setDuplicate(null);
    setEditingEmail(false);
  };

  const canAnalyze = files.length > 0 && !!location && !analyzing;

  return (
    <div style={{ padding: '40px 0 80px' }}>
      <div className="container" style={{ maxWidth: 680 }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ fontSize: 28, marginBottom: 6 }}>📸 Report a Civic Issue</h1>
          <p style={{ color: '#64748b', margin: 0 }}>
            {step === 'form'
              ? 'Upload evidence and share your location to begin.'
              : 'Review the AI analysis below, then submit.'}
          </p>
        </div>

        {/* ════════════════════════════════════════════════════════════════
            STEP 1 — Upload + Location + "AI Analysis" button
           ════════════════════════════════════════════════════════════════ */}
        {step === 'form' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* ── Media ── */}
            <div className="card" style={{ padding: '28px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1e3a5f', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>1</div>
                <h2 style={{ fontSize: 17, margin: 0 }}>Upload Evidence</h2>
              </div>
              <p style={{ color: '#64748b', fontSize: 13, margin: '0 0 18px 38px' }}>
                Photos or videos of the issue — up to 3 files, 50 MB each.
              </p>

              <div {...getRootProps()} style={{
                border: `2.5px dashed ${isDragActive ? '#2e6da4' : '#cbd5e1'}`,
                borderRadius: 12, padding: '28px 20px', textAlign: 'center', cursor: 'pointer',
                background: isDragActive ? '#e8f4fd' : '#f8fafc', transition: 'all 0.2s'
              }}>
                <input {...getInputProps()} />
                <Upload size={28} color={isDragActive ? '#2e6da4' : '#94a3b8'} style={{ marginBottom: 10 }} />
                <p style={{ fontWeight: 600, color: '#334155', margin: '0 0 4px', fontSize: 14 }}>
                  {isDragActive ? 'Drop files here' : 'Drag & drop or click to select'}
                </p>
                <p style={{ color: '#94a3b8', fontSize: 12, margin: 0 }}>
                  JPG · PNG · WebP · MP4 · MOV
                </p>
              </div>

              {previews.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 14 }}>
                  {previews.map((p, i) => (
                    <div key={i} style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', aspectRatio: '1', background: '#f1f5f9' }}>
                      {p.type === 'image'
                        ? <img src={p.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <video src={p.url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                      <div style={{ position: 'absolute', top: 5, left: 5, background: 'rgba(0,0,0,0.55)', borderRadius: 4, padding: '2px 6px' }}>
                        {p.type === 'video' ? <Video size={11} color="white" /> : <Camera size={11} color="white" />}
                      </div>
                      <button onClick={() => removeFile(i)} style={{
                        position: 'absolute', top: 5, right: 5, width: 22, height: 22,
                        background: '#ef4444', color: 'white', border: 'none', borderRadius: '50%',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                      }}>
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Location ── */}
            <div className="card" style={{ padding: '28px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1e3a5f', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>2</div>
                <h2 style={{ fontSize: 17, margin: 0 }}>Share Location</h2>
              </div>
              <p style={{ color: '#64748b', fontSize: 13, margin: '0 0 18px 38px' }}>
                GPS location routes your issue to the right authority and detects duplicates.
              </p>

              <button
                className="btn btn-primary"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                onClick={getLocation}
                disabled={locLoading}
              >
                {locLoading
                  ? <><Loader size={16} className="spin" /> Detecting…</>
                  : <><MapPin size={16} /> Use My Current Location</>}
              </button>

              {location && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 14px', marginBottom: 12, fontSize: 13, color: '#166534' }}>
                    ✅ <strong>Location captured</strong><br />
                    <span style={{ color: '#047857', fontSize: 12 }}>{address}</span>
                  </div>
                  <div style={{ height: 220, borderRadius: 10, overflow: 'hidden', border: '1px solid #e2e8f0' }}>
                    <MapContainer center={[location.latitude, location.longitude]} zoom={16} style={{ height: '100%' }}>
                      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                      <Marker position={[location.latitude, location.longitude]}>
                        <Popup>Issue location</Popup>
                      </Marker>
                    </MapContainer>
                  </div>
                </div>
              )}
            </div>

            {/* ── Duplicate warning (from analyze step) ── */}
            {duplicate && <DuplicateCard duplicate={duplicate} navigate={navigate} />}

            {/* ── Checklist + AI Analysis button ── */}
            <div className="card" style={{ padding: '20px 24px', background: canAnalyze ? '#eff6ff' : '#f8fafc', border: `1.5px solid ${canAnalyze ? '#bfdbfe' : '#e2e8f0'}`, transition: 'all 0.3s' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
                <CheckItem done={files.length > 0} label={files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''} ready` : 'Upload at least 1 photo or video'} />
                <CheckItem done={!!location}        label={location ? 'Location captured' : 'Capture your GPS location'} />
              </div>

              <button
                className={`btn btn-primary btn-lg ${analyzing ? 'btn-loading' : ''}`}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: canAnalyze ? '#2e6da4' : undefined }}
                onClick={handleAnalyze}
                disabled={!canAnalyze}
              >
                {analyzing
                  ? <><Loader size={16} className="spin" /> Analysing…</>
                  : <><Sparkles size={16} /> Run AI Analysis</>}
              </button>
              <p style={{ fontSize: 12, color: '#64748b', textAlign: 'center', margin: '10px 0 0' }}>
                AI will detect the issue category, write a description, and identify the responsible authority for review before you submit.
              </p>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            STEP 2 — Preview AI analysis, edit authority email, Submit
           ════════════════════════════════════════════════════════════════ */}
        {step === 'preview' && analysis && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            <button
              onClick={backToForm}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#2e6da4', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}
            >
              <ArrowLeft size={14} /> Back to edit photos / location
            </button>

            {/* Media thumbnails (read-only at this point) */}
            <div className="card" style={{ padding: '20px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Sparkles size={16} color="#2e6da4" />
                <h2 style={{ fontSize: 15, margin: 0, color: '#1e3a5f' }}>AI Analysis Result</h2>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 18 }}>
                {analysis.media.map((m, i) => (
                  <div key={i} style={{ borderRadius: 8, overflow: 'hidden', aspectRatio: '1', background: '#f1f5f9' }}>
                    {m.type === 'image'
                      ? <img src={m.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <video src={m.url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  </div>
                ))}
              </div>

              <Field label="Title">{analysis.title}</Field>
              <Field label="Category">{analysis.category.replace(/_/g, ' ').toUpperCase()}</Field>
              <Field label="AI Description">{analysis.aiDescription}</Field>
              <Field label="Location">{analysis.location.address}</Field>

              <div style={{ marginTop: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>Severity</span>
                <div style={{ marginTop: 6 }}>
                  <span style={{
                    display: 'inline-block', padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                    background: (SEVERITY_COLORS[analysis.severity] || SEVERITY_COLORS.medium).bg,
                    color:      (SEVERITY_COLORS[analysis.severity] || SEVERITY_COLORS.medium).text,
                    border:     `1px solid ${(SEVERITY_COLORS[analysis.severity] || SEVERITY_COLORS.medium).border}`
                  }}>
                    {analysis.severity?.toUpperCase()}
                  </span>
                  {typeof analysis.aiConfidence === 'number' && (
                    <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 10 }}>
                      AI confidence: {Math.round(analysis.aiConfidence * 100)}%
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Assigned authority — only email is editable */}
            <div className="card" style={{ padding: '20px 24px' }}>
              <h2 style={{ fontSize: 15, margin: '0 0 14px', color: '#1e3a5f' }}>🏛️ Assigned Authority</h2>

              <Field label="Department">{analysis.assignedAuthority.department}</Field>
              <Field label="Authority Name">{analysis.assignedAuthority.name}</Field>
              {analysis.assignedAuthority.jurisdiction && (
                <Field label="Jurisdiction">{analysis.assignedAuthority.jurisdiction}</Field>
              )}
              {analysis.assignedAuthority.phone && (
                <Field label="Phone">{analysis.assignedAuthority.phone}</Field>
              )}

              {/* Editable email */}
              <div style={{ marginTop: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Contact Email
                </span>
                <div style={{ marginTop: 6 }}>
                  {editingEmail ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="email"
                        value={emailDraft}
                        onChange={e => setEmailDraft(e.target.value)}
                        autoFocus
                        style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1.5px solid #2e6da4', fontSize: 13 }}
                      />
                      <button
                        onClick={saveEmailEdit}
                        style={{ background: '#10b981', color: 'white', border: 'none', borderRadius: 8, padding: '0 14px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                      >
                        <Check size={15} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155' }}>
                        <Mail size={14} color="#64748b" /> {analysis.assignedAuthority.email}
                      </span>
                      <button
                        onClick={() => { setEmailDraft(analysis.assignedAuthority.email); setEditingEmail(true); }}
                        style={{ background: 'none', border: 'none', color: '#2e6da4', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}
                      >
                        <Pencil size={12} /> Edit
                      </button>
                    </div>
                  )}
                </div>
                <p style={{ fontSize: 11, color: '#94a3b8', margin: '6px 0 0' }}>
                  AI-resolved from public records ({analysis.assignedAuthority.emailSource}). Correct it here only if you know it's wrong.
                </p>
              </div>
            </div>

            {/* Duplicate warning (race-condition catch at submit time) */}
            {duplicate && <DuplicateCard duplicate={duplicate} navigate={navigate} />}

            {/* Final submit */}
            <div className="card" style={{ padding: '20px 24px', background: '#f0fdf4', border: '1.5px solid #bbf7d0' }}>
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#92400e' }}>
                ⚠️ Your name is shared with the authority. Email, phone, and Aadhaar remain private.
              </div>

              <button
                className={`btn btn-primary btn-lg ${submitting ? 'btn-loading' : ''}`}
                style={{ width: '100%', background: '#10b981' }}
                onClick={handleSubmit}
                disabled={submitting || editingEmail}
              >
                {!submitting && '🚀 Submit Issue Report'}
              </button>
              {editingEmail && (
                <p style={{ fontSize: 12, color: '#92400e', textAlign: 'center', margin: '8px 0 0' }}>
                  Save or cancel your email edit before submitting.
                </p>
              )}
            </div>
          </div>
        )}

      </div>
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function CheckItem({ done, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
      <div style={{
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
        background: done ? '#10b981' : '#e2e8f0', color: done ? 'white' : '#94a3b8',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, transition: 'all 0.3s'
      }}>{done ? '✓' : '○'}</div>
      <span style={{ color: done ? '#166534' : '#64748b', fontWeight: done ? 600 : 400 }}>{label}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      <p style={{ fontSize: 14, color: '#1e293b', margin: '4px 0 0', lineHeight: 1.5 }}>{children}</p>
    </div>
  );
}

function DuplicateCard({ duplicate, navigate }) {
  return (
    <div style={{ background: '#fff7ed', border: '1.5px solid #fed7aa', borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <AlertTriangle size={20} color="#ea580c" style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <strong style={{ color: '#9a3412', fontSize: 15 }}>This issue is already filed!</strong>
          <p style={{ color: '#c2410c', fontSize: 13, margin: '4px 0 0' }}>{duplicate.message}</p>
        </div>
      </div>
      {duplicate.existingIssue && (
        <div style={{ background: 'white', border: '1px solid #fed7aa', borderRadius: 10, padding: '14px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {duplicate.existingIssue.thumbnail && (
            <img src={duplicate.existingIssue.thumbnail} alt="" style={{ width: 60, height: 60, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b', marginBottom: 4 }}>{duplicate.existingIssue.title}</div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
              🏛️ {duplicate.existingIssue.authority || duplicate.existingIssue.department} &nbsp;·&nbsp;
              👍 {duplicate.existingIssue.upvoteCount} upvotes &nbsp;·&nbsp;
              Status: <strong>{duplicate.existingIssue.status?.replace(/_/g, ' ')}</strong>
            </div>
            <button
              className="btn btn-primary"
              style={{ fontSize: 13, padding: '7px 16px' }}
              onClick={() => navigate(`/track/${duplicate.existingIssue.issueId}`)}
            >
              View & Upvote This Issue →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
