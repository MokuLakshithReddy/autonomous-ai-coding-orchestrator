import React from 'react';

/**
 * AmbientBackground
 * Atmospheric midnight lighting with slow-moving violet and cyan light fields,
 * floating particles, and a subtle engineering grid.
 * GPU-accelerated with CSS transforms and opacity (24-34s duration).
 * Respects prefers-reduced-motion and does not capture pointer events.
 */
export const AmbientBackground: React.FC = () => {
  return (
    <div className="ambient-background" aria-hidden="true">
      {/* Primary Electric Violet Floating Glow Field */}
      <div className="ambient-orb ambient-orb-violet" />

      {/* Secondary Aurora Cyan Floating Glow Field */}
      <div className="ambient-orb ambient-orb-cyan" />

      {/* Center Soft Lavender Atmospheric Aura */}
      <div className="ambient-orb ambient-orb-center" />

      {/* High-Tech Fine Coordinate Mesh */}
      <div className="ambient-mesh-grid" />
    </div>
  );
};

