import React from 'react';
import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer style={{
      background: '#1e3a5f', color: 'white',
      padding: '40px 0 20px', marginTop: 'auto'
    }}>
      <div className="container">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 32, marginBottom: 32 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 22 }}>🏛️</span>
              <span style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 18 }}>CivicPulse</span>
            </div>
            <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6 }}>
              Empowering citizens to report, track, and resolve community issues through collaboration and AI.
            </p>
          </div>
          <div>
            <h4 style={{ color: 'white', marginBottom: 12, fontSize: 15 }}>Platform</h4>
            {[
              { to: '/report', label: 'Report an Issue' },
              { to: '/issues', label: 'Track Issues' },
              { to: '/leaderboard', label: 'Leaderboard' },
            ].map(l => (
              <Link key={l.to} to={l.to} style={{ display: 'block', color: '#94a3b8', fontSize: 14, marginBottom: 8, textDecoration: 'none' }}>{l.label}</Link>
            ))}
          </div>
          <div>
            <h4 style={{ color: 'white', marginBottom: 12, fontSize: 15 }}>Categories</h4>
            {['Road Damage', 'Water Supply', 'Electricity', 'Garbage', 'Street Lights'].map(c => (
              <div key={c} style={{ color: '#94a3b8', fontSize: 14, marginBottom: 8 }}>{c}</div>
            ))}
          </div>
        </div>
        <div style={{ borderTop: '1px solid #334155', paddingTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>© 2026 CivicPulse. All rights reserved.</p>
          <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>🇮🇳 Made for India's citizens</p>
        </div>
      </div>
    </footer>
  );
}
