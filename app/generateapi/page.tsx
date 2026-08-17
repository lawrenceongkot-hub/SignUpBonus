'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Key, Shield, ShieldCheck, Lock, Copy, Check, RefreshCw, AlertTriangle, LogOut, ArrowLeft, Database, CheckCircle2 } from 'lucide-react';

interface ApiKeyItem {
  id: string;
  keyPrefix: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  _count?: { sessions: number };
}

interface NewlyGeneratedKey {
  id: string;
  rawKey: string;
  keyPrefix: string;
  label: string;
}

interface DbHealth {
  connected: boolean;
  provider: string;
  sourceVariable: string;
  tablesReady: boolean;
  error?: string;
}

export default function GenerateApiPage() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [submittingLogin, setSubmittingLogin] = useState<boolean>(false);

  const [keyLabel, setKeyLabel] = useState<string>('');
  const [generating, setGenerating] = useState<boolean>(false);
  const [newKey, setNewKey] = useState<NewlyGeneratedKey | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [genError, setGenError] = useState<string>('');

  const [keysList, setKeysList] = useState<ApiKeyItem[]>([]);
  const [fetchingKeys, setFetchingKeys] = useState<boolean>(false);
  const [dbHealth, setDbHealth] = useState<DbHealth | null>(null);

  // Check database health & keys
  const fetchKeysAndHealth = async () => {
    setFetchingKeys(true);
    setGenError('');
    try {
      // 1. Fetch DB Health
      const healthRes = await fetch('/api/admin/db-health');
      if (healthRes.ok) {
        const healthData = await healthRes.json();
        setDbHealth(healthData);
      }

      // 2. Fetch Keys
      const res = await fetch('/api/admin/keys');
      if (res.status === 401) {
        setIsAuthenticated(false);
      } else if (res.ok) {
        const data = await res.json();
        setKeysList(data.keys || []);
        setIsAuthenticated(true);
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.error) setGenError(data.error);
      }
    } catch (err) {
      console.error('Failed to fetch keys or DB health:', err);
    } finally {
      setFetchingKeys(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeysAndHealth();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setSubmittingLogin(true);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok) {
        setIsAuthenticated(true);
        setPassword('');
        fetchKeysAndHealth();
      } else {
        setLoginError(data.error || 'Authentication failed');
      }
    } catch (err) {
      setLoginError('Network connection failed');
    } finally {
      setSubmittingLogin(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
      setIsAuthenticated(false);
      setNewKey(null);
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenerating(true);
    setCopied(false);
    setGenError('');

    try {
      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: keyLabel || undefined }),
      });

      const data = await res.json();

      if (res.ok && data.apiKey) {
        setNewKey(data.apiKey);
        setKeyLabel('');
        fetchKeysAndHealth();
      } else {
        setGenError(data.error || 'Failed to generate API key. Verify PostgreSQL DATABASE_URL.');
      }
    } catch (err: any) {
      setGenError(err.message || 'Network error while contacting API key service.');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!confirm('Are you sure you want to revoke this API key? Any active operator sessions using it will immediately be invalidated.')) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/keys/${keyId}/revoke`, {
        method: 'POST',
      });

      if (res.ok) {
        fetchKeysAndHealth();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to revoke key');
      }
    } catch (err) {
      alert('Error revoking key');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--text-secondary)' }}>
          <RefreshCw className="pulse" size={20} />
          <span>Verifying administrator session...</span>
        </div>
      </div>
    );
  }

  // If not authenticated, render Admin Login Form
  if (!isAuthenticated) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '20px' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '440px', padding: '36px 32px' }}>
          <div style={{ textAlign: 'center', marginBottom: '28px' }}>
            <div style={{
              width: '56px',
              height: '56px',
              borderRadius: '14px',
              background: 'rgba(59, 130, 246, 0.15)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
              color: 'var(--accent-blue)',
              border: '1px solid rgba(59, 130, 246, 0.3)'
            }}>
              <Shield size={28} />
            </div>
            <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '6px' }}>ADMIN PANEL</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              Authenticate with server-side administrator credentials
            </p>
          </div>

          {loginError && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#fca5a5',
              padding: '12px 14px',
              borderRadius: '8px',
              marginBottom: '20px',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px'
            }}>
              <AlertTriangle size={18} />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Administrator Username
              </label>
              <input
                type="text"
                className="glass-input"
                placeholder="Enter admin username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Administrator Password
              </label>
              <input
                type="password"
                className="glass-input"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              className="btn-primary"
              disabled={submittingLogin}
              style={{ width: '100%', marginTop: '6px', height: '44px' }}
            >
              <Lock size={16} />
              {submittingLogin ? 'Authenticating...' : 'Sign In to Admin Panel'}
            </button>
          </form>

          <div style={{ marginTop: '24px', textAlign: 'center' }}>
            <Link href="/" style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <ArrowLeft size={14} /> Back to Operator Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Authenticated Admin Dashboard
  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '36px 20px', width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: '46px',
            height: '46px',
            borderRadius: '12px',
            background: 'rgba(59, 130, 246, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent-blue)',
            border: '1px solid rgba(59, 130, 246, 0.3)'
          }}>
            <ShieldCheck size={26} />
          </div>
          <div>
            <h1 style={{ fontSize: '26px', fontWeight: '800' }}>ADMIN PANEL</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              Cryptographic API Key Management & Revocation Authority
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {dbHealth && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 12px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: '600',
              background: dbHealth.connected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              border: `1px solid ${dbHealth.connected ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              color: dbHealth.connected ? '#34d399' : '#f87171',
            }}>
              <Database size={14} />
              <span>{dbHealth.connected ? `DB: ${dbHealth.sourceVariable}` : 'DB Not Connected'}</span>
            </div>
          )}
          <Link href="/" className="btn-secondary">
            <ArrowLeft size={16} /> Operator Dashboard
          </Link>
          <button onClick={handleLogout} className="btn-danger">
            <LogOut size={16} /> Logout
          </button>
        </div>
      </div>

      {/* Database Not Connected Banner Guide */}
      {dbHealth && !dbHealth.connected && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.12)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '12px',
          padding: '20px',
          marginBottom: '24px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <AlertTriangle size={20} style={{ color: '#f87171' }} />
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: '#f87171' }}>
              Action Required: Configure DATABASE_URL in Vercel
            </h3>
          </div>
          <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.5', marginBottom: '12px' }}>
            The application requires a PostgreSQL database to securely store and authenticate hashed API keys and sessions.
          </p>
          <div style={{ background: 'rgba(0, 0, 0, 0.3)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px', color: '#93c5fd' }}>
            <strong>How to configure in Vercel:</strong>
            <ol style={{ paddingLeft: '20px', marginTop: '6px', lineHeight: '1.6' }}>
              <li>Go to your project on <a href="https://vercel.com/dashboard" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>Vercel Dashboard</a>.</li>
              <li>Navigate to <strong>Storage</strong> tab &rarr; Click <strong>Create Database</strong> &rarr; Select <strong>Postgres (Neon)</strong> &rarr; Click <strong>Connect</strong>.</li>
              <li>Or go to <strong>Settings</strong> &rarr; <strong>Environment Variables</strong> &rarr; Add <code>DATABASE_URL</code> with your PostgreSQL connection URL.</li>
              <li>Redeploy your project for the changes to take effect.</li>
            </ol>
          </div>
        </div>
      )}

      {/* API Key Generation Card */}
      <div className="glass-panel" style={{ padding: '28px', marginBottom: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
          <Key size={22} style={{ color: 'var(--accent-blue)' }} />
          <h2 style={{ fontSize: '18px', fontWeight: '700' }}>Generate API Key</h2>
        </div>

        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
          Generate a high-entropy, cryptographically random API key (256-bit entropy). Keys are stored as SHA-256 hashes in PostgreSQL and are never displayed again after generation.
        </p>

        {genError && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#fca5a5',
            padding: '14px 16px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }}>
            <AlertTriangle size={20} style={{ flexShrink: 0 }} />
            <div>
              <strong>Generation Error:</strong> {genError}
            </div>
          </div>
        )}

        <form onSubmit={handleGenerateKey} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="glass-input"
            placeholder="Operator Label (e.g. Tier-1 Support, Mobile Ops)"
            value={keyLabel}
            onChange={(e) => setKeyLabel(e.target.value)}
            style={{ flex: '1', minWidth: '260px' }}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={generating}
            style={{ minWidth: '220px' }}
          >
            <Key size={16} />
            {generating ? 'Generating...' : 'Generate New API Key'}
          </button>
        </form>

        {/* Newly Generated Key Alert */}
        {newKey && (
          <div style={{
            marginTop: '24px',
            padding: '20px',
            background: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '10px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <span style={{ color: '#34d399', fontWeight: '700', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Check size={18} /> API Key Generated Successfully
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {newKey.label}
              </span>
            </div>

            <p style={{ fontSize: '13px', color: '#cbd5e1', marginBottom: '12px' }}>
              Copy this API key now. For security purposes, it will <strong>never be shown again</strong>.
            </p>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              background: 'rgba(0, 0, 0, 0.4)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '10px 14px',
              gap: '12px',
              fontFamily: 'var(--font-mono)'
            }}>
              <span style={{ flex: 1, fontSize: '14px', color: '#67e8f9', wordBreak: 'break-all' }}>
                {newKey.rawKey}
              </span>
              <button
                onClick={() => copyToClipboard(newKey.rawKey)}
                className="btn-primary"
                style={{ padding: '6px 14px', fontSize: '12px', minWidth: '90px' }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied!' : 'Copy Key'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Active API Keys Table */}
      <div className="glass-panel" style={{ padding: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Shield size={20} style={{ color: 'var(--accent-blue)' }} />
            <h2 style={{ fontSize: '18px', fontWeight: '700' }}>Active API Keys & Revocation</h2>
          </div>
          <button onClick={fetchKeysAndHealth} className="btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>
            <RefreshCw size={14} className={fetchingKeys ? 'pulse' : ''} /> Refresh
          </button>
        </div>

        {keysList.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <Key size={36} style={{ marginBottom: '12px', opacity: 0.4 }} />
            <p>No API keys generated yet. Click "Generate New API Key" above.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                  <th style={{ padding: '12px 16px', fontWeight: '600' }}>Prefix</th>
                  <th style={{ padding: '12px 16px', fontWeight: '600' }}>Label</th>
                  <th style={{ padding: '12px 16px', fontWeight: '600' }}>Created At</th>
                  <th style={{ padding: '12px 16px', fontWeight: '600' }}>Last Used</th>
                  <th style={{ padding: '12px 16px', fontWeight: '600' }}>Status</th>
                  <th style={{ padding: '12px 16px', fontWeight: '600', textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {keysList.map((key) => {
                  const isRevoked = !!key.revokedAt;
                  return (
                    <tr key={key.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                      <td style={{ padding: '14px 16px', fontFamily: 'var(--font-mono)', color: '#93c5fd' }}>
                        {key.keyPrefix}
                      </td>
                      <td style={{ padding: '14px 16px', fontWeight: '500' }}>
                        {key.label}
                      </td>
                      <td style={{ padding: '14px 16px', color: 'var(--text-muted)', fontSize: '13px' }}>
                        {new Date(key.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '14px 16px', color: 'var(--text-muted)', fontSize: '13px' }}>
                        {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        {isRevoked ? (
                          <span className="badge badge-ended">Revoked</span>
                        ) : (
                          <span className="badge badge-connected">Active</span>
                        )}
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                        {!isRevoked && (
                          <button
                            onClick={() => handleRevokeKey(key.id)}
                            className="btn-danger"
                            style={{ padding: '6px 12px', fontSize: '12px' }}
                          >
                            Revoke Key
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
