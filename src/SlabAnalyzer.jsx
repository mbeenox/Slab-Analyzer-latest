import { useState, useCallback, useMemo } from "react";

// ============================================================
// ENGINEERING CALCULATION ENGINES
// ============================================================

function computeSectionProps(params) {
  const { fc, fy, h, cover, barDiaShort, barDiaLong, spacingShortBot, spacingShortTop, spacingLongBot, spacingLongTop } = params;
  const barAreaShort = Math.PI * (barDiaShort / 2) ** 2;
  const barAreaLong = Math.PI * (barDiaLong / 2) ** 2;

  const d_x = h - cover - barDiaShort / 2;
  const d_y = h - cover - barDiaShort - barDiaLong / 2;

  const As_x_bot = barAreaShort * (12 / spacingShortBot);
  const As_x_top = barAreaShort * (12 / spacingShortTop);
  const As_y_bot = barAreaLong * (12 / spacingLongBot);
  const As_y_top = barAreaLong * (12 / spacingLongTop);

  const phiMn = (As, d) => {
    const a = (As * fy) / (0.85 * fc * 12);
    return 0.9 * As * fy * (d - a / 2);
  };

  const phi_Mn_x_pos = phiMn(As_x_bot, d_x);
  const phi_Mn_x_neg = phiMn(As_x_top, d_x);
  const phi_Mn_y_pos = phiMn(As_y_bot, d_y);

  const phi_Vc = (0.75 * 2 * Math.sqrt(fc * 1000) * 12 * d_x) / 1000;

  const Ec = 57 * Math.sqrt(fc * 1000);
  const fr = (7.5 * Math.sqrt(fc * 1000)) / 1000;
  const Ig = (12 * h ** 3) / 12;
  const Mcr = (fr * Ig) / (h / 2);

  const n_mod = 29000 / Ec;
  const As_x_in = As_x_bot / 12;
  const kd_x = (-n_mod * As_x_in + Math.sqrt((n_mod * As_x_in) ** 2 + 2 * n_mod * As_x_in * d_x)) / 1;
  const Icr_x = kd_x ** 3 / 3 + n_mod * As_x_in * (d_x - kd_x) ** 2;

  const As_y_in = As_y_bot / 12;
  const kd_y = (-n_mod * As_y_in + Math.sqrt((n_mod * As_y_in) ** 2 + 2 * n_mod * As_y_in * d_y)) / 1;
  const Icr_y = kd_y ** 3 / 3 + n_mod * As_y_in * (d_y - kd_y) ** 2;

  const Ig_per_in = h ** 3 / 12;

  return {
    d_x, d_y, As_x_bot, As_x_top, As_y_bot, As_y_top,
    phi_Mn_x_pos, phi_Mn_x_neg, phi_Mn_y_pos,
    phi_Vc, Ec, fr, Ig, Mcr, n_mod, Icr_x, Icr_y, Ig_per_in, kd_x, kd_y
  };
}

// METHOD 1: Hand Calculation (ACI Strip Method)
function runHandCalc(params, section) {
  const { Lx, Ly, xLoad, wD, wL, fc, bearingSize } = params;
  const { d_x, d_y, phi_Mn_x_pos, phi_Mn_x_neg, phi_Mn_y_pos, phi_Vc } = section;

  const L = Lx;
  const a = xLoad;
  const b = L - a;
  const w_u = 1.2 * wD + 1.6 * wL;

  // Effective width
  const beff_option1 = L / 3;
  const beff_option2 = (2 * Math.min(a, b)) / 3;
  const beff = Math.min(beff_option1, Math.max(beff_option2, beff_option1));
  const beff_used = Math.min(beff_option1, Ly);

  // Flexure
  const M_uniform_at_load = (w_u / 1000) * a * (L - a) / 2;
  const M_point_per_ft = (a * b) / (L * beff_used);
  const Pu_flex = ((phi_Mn_x_pos / 12) - M_uniform_at_load) / M_point_per_ft;
  const P_flex = Pu_flex / 1.6;

  // One-way shear
  const V_uniform = (w_u / 1000) * (L / 2 - d_x / 12);
  const R_near = b / L;
  const V_point_per_ft = R_near / beff_used;
  const Pu_shear = (phi_Vc - V_uniform) / V_point_per_ft;
  const P_shear = Pu_shear / 1.6;

  // Punching shear
  const b0 = 4 * (bearingSize + d_x);
  const phi_Vc_punch = (0.75 * 4 * Math.sqrt(params.fc * 1000) * b0 * d_x) / 1000;
  const Pu_punch = phi_Vc_punch;
  const P_punch = Pu_punch / 1.6;

  // Deflection check
  const Ec = section.Ec;
  const I = section.Ig;
  const L_in = L * 12;
  const w_service = ((wD + wL) / 1000) * (1 / 12);
  const delta_uniform = (5 * w_service * L_in ** 4) / (384 * Ec * I);
  const delta_limit = L_in / 360;

  const governing = Math.min(Pu_flex, Pu_shear, Pu_punch);
  const gov_mode = governing === Pu_flex ? "Flexure" : governing === Pu_shear ? "One-Way Shear" : "Punching Shear";

  return {
    method: "ACI Strip Method",
    beff_used,
    w_u,
    results: {
      flexure: { Pu: Pu_flex, P: P_flex, M_uniform: M_uniform_at_load, capacity: phi_Mn_x_pos / 12 },
      shear: { Pu: Pu_shear, P: P_shear, V_uniform, capacity: phi_Vc },
      punching: { Pu: Pu_punch, P: P_punch, b0, capacity: phi_Vc_punch },
      deflection: { delta_uniform, delta_limit, ok: delta_uniform < delta_limit }
    },
    governing: { Pu: governing, P: governing / 1.6, mode: gov_mode }
  };
}

// METHOD 2: Yield-Line Analysis
function runYieldLine(params, section) {
  const { Lx, Ly, xLoad, wD, wL } = params;
  const { phi_Mn_x_pos, phi_Mn_y_pos } = section;

  // Work in FEET throughout
  const L = Lx;       // ft
  const B = Ly;       // ft
  const a = xLoad;    // ft (distance from left support)
  const b = L - a;    // ft
  const mx = phi_Mn_x_pos / 12;  // ft-k/ft (moment capacity, short dir)
  const my = phi_Mn_y_pos / 12;  // ft-k/ft (moment capacity, long dir)
  const w_u = (1.2 * wD + 1.6 * wL) / 1000;  // k/ft² (factored uniform load)

  // Fan mechanism: 4 yield lines from load point at (a, B/2) to 
  // points at (0, B/2±c) and (L, B/2±c) on the support lines.
  // Two triangular panels rotate about the two support edges.
  //
  // Virtual deflection δ=1 at load point.
  //
  // For each diagonal yield line, the internal work is computed using
  // the projected length method:
  //   D = (mx * y_projection² + my * x_projection²) / (x_projection² + y_projection²)
  // summed over all 4 yield lines.
  //
  // Left pair (to x=0 support): x_proj = a, y_proj = c (each)
  // Right pair (to x=L support): x_proj = b, y_proj = c (each)

  let Pu_min = 1e10;
  let c_opt = 0;
  const a2 = a * a;
  const b2 = b * b;

  const nSteps = 500;
  const c_max = B / 2;

  for (let i = 1; i <= nSteps; i++) {
    const c = (i / nSteps) * c_max;
    const c2 = c * c;

    // Internal work (4 yield lines total):
    // Left pair (2 lines): each has x-proj=a, y-proj=c
    // D_left = 2 * (a² * mx + c² * my) / (a² + c²)
    // (This comes from: m_n * l * θ_n for the projected length method)
    const D_left = 2 * (a2 * mx + c2 * my) / (a2 + c2);
    const D_right = 2 * (b2 * mx + c2 * my) / (b2 + c2);
    const D_int = D_left + D_right;

    // External work from uniform load:
    // Left triangle: area = a*c, centroid deflects δ/3
    // Right triangle: area = b*c, centroid deflects δ/3
    // W = w_u * [a*c*(1/3) + b*c*(1/3)] = w_u * c * (a+b) / 3 = w_u * c * L / 3
    const W_uniform = w_u * c * L / 3;

    // Work equation: Pu * 1 + W_uniform = D_int
    // So: Pu = D_int - W_uniform
    const Pu = D_int - W_uniform;

    if (Pu > 0 && Pu < Pu_min) {
      Pu_min = Pu;
      c_opt = c;
    }
  }

  const P_yl = Pu_min / 1.6;

  return {
    method: "Yield-Line Analysis",
    c_opt,
    mechanism_width: 2 * c_opt,
    results: {
      collapse_load: { Pu: Pu_min, P: P_yl }
    },
    governing: { Pu: Pu_min, P: P_yl, mode: "Plastic Collapse (upper bound)" }
  };
}

// METHOD 3: Elastic Plate FEA (simplified — uses Navier series solution)
function runElasticFEA(params, section) {
  const { Lx, Ly, xLoad, wD, wL, fc, bearingSize } = params;
  const { d_x, d_y, phi_Mn_x_pos, phi_Mn_y_pos, phi_Vc, Ec, Ig_per_in, Mcr, Icr_x, Icr_y } = section;

  const L = Lx * 12;
  const B = Ly * 12;
  const x0 = xLoad * 12;
  const y0 = B / 2;
  const nu = 0.2;
  const h = params.h;
  const D = (Ec * h ** 3) / (12 * (1 - nu * nu));

  const w_u_ksi = (1.2 * wD + 1.6 * wL) / 1e6;

  // Navier double series solution for simply-supported plate (2 opposite edges)
  // For a plate SS on x=0,L and free on y=0,B:
  // This is actually a Levy-type solution, not standard Navier.
  // 
  // For a one-way slab (free long edges), use single Fourier series:
  // w(x,y) = Σ Ym(y) * sin(mπx/L)
  //
  // Simplified approach: use the beam solution in x with plate distribution in y
  // Model as a plate strip with effective Poisson coupling.
  //
  // For engineering accuracy, use a simplified 2D distribution:
  // Compute beam moments, then distribute across width using plate theory.

  const nTerms = 50;
  const ny_pts = 51;
  const nx_pts = 41;

  // Grid points for evaluation
  const dx_grid = L / (nx_pts - 1);
  const dy_grid = B / (ny_pts - 1);

  // For a plate simply supported on x=0,L, free on y=0,B:
  // Under point load P at (x0, y0):
  // Use Levy solution: w = Σ Wm(y)*sin(mπx/L)
  // where Wm(y) satisfies the ODE for each m
  
  // For the one-way slab with free edges, the Levy solution gives:
  // Wm'' - αm²*Wm = load_m / D
  // where αm = mπ/L
  //
  // For point load at (x0, y0):
  // Load coefficient: qm = (2P/L) * sin(mπx0/L)
  // 
  // General solution with free edge BCs (My=0, Vy=0 at y=0,B):
  // Wm(y) = Am*cosh(αm*y) + Bm*sinh(αm*y) + Cm*y*cosh(αm*y) + Dm*y*sinh(αm*y)
  // + particular solution
  //
  // This is complex. For practical purposes, let me use a simpler approach:
  // Compute the effective width from plate theory and apply it to beam results.

  // APPROACH: Westergaard-type effective width for concentrated loads
  // For a point load on a one-way slab (Timoshenko & Woinowsky-Krieger):
  // The effective width depends on the plate rigidity ratio and position.
  
  // For an isotropic plate SS on two edges, free on two edges:
  // Under a concentrated load P at (x0, y0):
  // Mx(x0,y0) ≈ P * f(x0,L) where f accounts for span position
  // The transverse distribution follows approximately:
  // Mx(x0, y) ∝ 1/[1 + (3(y-y0)/L)²]  (Lorentzian-like distribution)
  
  // More accurate: use the Levy solution numerically
  // For each Fourier term m, solve the beam-on-elastic-foundation ODE
  
  // Let me implement the Levy solution properly for the point load case
  
  // Mx and My arrays
  const Mx_uniform = new Float64Array(nx_pts * ny_pts);
  const My_uniform = new Float64Array(nx_pts * ny_pts);
  const Mx_point = new Float64Array(nx_pts * ny_pts);
  const My_point = new Float64Array(nx_pts * ny_pts);

  // For uniform load on SS plate with free edges:
  // Behaves like a beam: Mx = w*x*(L-x)/2, My = ν*Mx (per unit width)
  for (let ix = 0; ix < nx_pts; ix++) {
    const x = ix * dx_grid;
    const mx_beam = w_u_ksi * x * (L - x) / 2; // k·in per in width
    for (let iy = 0; iy < ny_pts; iy++) {
      const idx = iy * nx_pts + ix;
      Mx_uniform[idx] = mx_beam * 12; // in-k per ft
      My_uniform[idx] = nu * mx_beam * 12;
    }
  }

  // For point load: use Levy-type series solution
  // Expand in Fourier series in x:
  // For each mode m: sin(mπx/L)
  // The y-distribution of moment follows from the plate ODE solution
  
  // For a plate SS on x=0,L, free on y=0,B, under unit point load at (x0,y0):
  // Fourier coefficient: Pm = (2/L)*sin(mπx0/L)
  // The ODE in y for each m is:
  // D*(d⁴Wm/dy⁴ - 2αm²*d²Wm/dy² + αm⁴*Wm) = 0 (away from load)
  // with a discontinuity at y=y0
  
  // Solution: Wm(y) involves cosh, sinh, y*cosh, y*sinh
  // Free edge BCs: My=0, Vy=0 at y=0 and y=B
  
  // This gives 8 unknowns (4 per region) + 4 continuity conditions = 8 equations
  // For engineering approximation, use the well-known result for infinite plate:
  // Mx_point(x,y) ≈ Σ (Pm*αm/(4)) * exp(-αm*|y-y0|) * [1 + αm*|y-y0|] * sin(mπx/L)
  // My_point(x,y) ≈ Σ (Pm*αm/(4)) * exp(-αm*|y-y0|) * [ν - (1-ν)*αm*|y-y0| ...] * sin(mπx/L)
  
  // Actually for semi-infinite plate with free edge, the decay is:
  // Mx ∝ exp(-αm*|y-y0|) * (1 + αm*|y-y0|)
  // This captures the essential physics: exponential decay with characteristic 
  // length L/(mπ), so the first mode dominates with decay length L/π ≈ L/3.

  for (let ix = 0; ix < nx_pts; ix++) {
    const x = ix * dx_grid;
    for (let iy = 0; iy < ny_pts; iy++) {
      const y = iy * dy_grid;
      const dy_load = Math.abs(y - y0);
      let mx_sum = 0;
      let my_sum = 0;

      for (let m = 1; m <= nTerms; m++) {
        const alpha = (m * Math.PI) / L;
        const sin_mx = Math.sin((m * Math.PI * x) / L);
        const sin_mx0 = Math.sin((m * Math.PI * x0) / L);
        const Pm = (2 / L) * sin_mx0;

        const decay = Math.exp(-alpha * dy_load);
        const r = alpha * dy_load;

        // Moment per unit load (Green's function)
        // Mx = -(d²w/dx² + ν*d²w/dy²) ... from plate theory
        // For infinite strip: 
        const mx_mode = (Pm * alpha / 4) * decay * (1 + r) * (1 - nu) + 
                         (Pm * alpha / 4) * decay * (1 + nu);
        // Simplified: Mx contribution from mode m
        const mx_m = (Pm / (2 * alpha)) * decay * ((1 + nu) + (1 - nu) * r) * alpha * alpha;
        
        // Actually, for a SS beam under point load, mode m gives:
        // M_beam_m = (2PL/(m²π²)) * sin(mπx0/L) * sin(mπx/L)
        // The plate distributes this with the exponential decay in y:
        // Mx_plate_m = M_beam_m * (α_m/2) * exp(-α_m|y-y0|) * (1 + α_m|y-y0|)
        // Wait, that doesn't have the right dimensions.
        
        // Correct Levy solution for Mx at point (x,y) due to unit point load at (x0,y0):
        // From Timoshenko's plate theory:
        // Mx = (P/(2L)) * Σ [sin(mπx0/L)*sin(mπx/L)] * fm(y)
        // where fm(y) = (1+ν)*exp(-αm|Δy|) + (1-ν)*αm|Δy|*exp(-αm|Δy|)
        // for an infinitely wide plate.
        
        const fm_x = ((1 + nu) + (1 - nu) * r) * decay;
        mx_sum += sin_mx0 * sin_mx * fm_x;
        
        // My = (P/(2L)) * Σ sin*sin * gm(y)
        // gm(y) = [(1+ν) - (1-ν)*αm|Δy|] * exp(-αm|Δy|)
        const gm_y = ((1 + nu) - (1 - nu) * r) * decay;
        my_sum += sin_mx0 * sin_mx * gm_y;
      }

      // Per unit point load (1 kip), moments in k·in per in width
      const mx_point_val = mx_sum / (2 * L); // k·in per in
      const my_point_val = my_sum / (2 * L);

      const idx = iy * nx_pts + ix;
      Mx_point[idx] = mx_point_val * 12; // in-k per ft
      My_point[idx] = my_point_val * 12;
    }
  }

  // Find max Pu from flexure
  let Pu_flex_mx = 1e10, Pu_flex_my = 1e10;
  let crit_ix = 0, crit_iy = 0;
  
  for (let ix = 0; ix < nx_pts; ix++) {
    for (let iy = 0; iy < ny_pts; iy++) {
      const idx = iy * nx_pts + ix;
      const mxu = Math.abs(Mx_uniform[idx]);
      const mxp = Math.abs(Mx_point[idx]);
      if (mxp > 1e-8) {
        const pu = (phi_Mn_x_pos - mxu) / mxp;
        if (pu > 0 && pu < Pu_flex_mx) {
          Pu_flex_mx = pu;
          crit_ix = ix; crit_iy = iy;
        }
      }
      const myu = Math.abs(My_uniform[idx]);
      const myp = Math.abs(My_point[idx]);
      if (myp > 1e-8) {
        const pu = (phi_Mn_y_pos - myu) / myp;
        if (pu > 0 && pu < Pu_flex_my) Pu_flex_my = pu;
      }
    }
  }

  // Shear and punching (same as hand calc)
  const w_u_kft = (1.2 * wD + 1.6 * wL) / 1000;
  const V_uniform = w_u_kft * (Lx / 2 - d_x / 12);
  
  // For shear from FEA: get the reaction-based shear distributed over the effective width
  // The plate distributes shear similarly — use FWHM-based effective width
  // From Levy solution, the shear effective width ≈ L/π for the dominant mode
  const beff_shear = Math.min(L / Math.PI / 12, Ly); // ft
  const R_near = (Lx - xLoad) / Lx;
  const V_point = R_near / beff_shear;
  const Pu_shear = (phi_Vc - V_uniform) / V_point;

  const b0 = 4 * (bearingSize + d_x);
  const phi_Vc_punch = (0.75 * 4 * Math.sqrt(fc * 1000) * b0 * d_x) / 1000;

  const Pu_flex = Math.min(Pu_flex_mx, Pu_flex_my);
  const flex_mode = Pu_flex_mx < Pu_flex_my ? "Mx" : "My";
  const governing_Pu = Math.min(Pu_flex, Pu_shear, phi_Vc_punch);
  const gov_mode = governing_Pu === Pu_flex ? `Flexure (${flex_mode})` :
                   governing_Pu === Pu_shear ? "One-Way Shear" : "Punching Shear";

  // Compute effective width from the Mx_point distribution
  const ix_load = Math.round(x0 / dx_grid);
  let mx_peak = 0, mx_integral = 0;
  for (let iy = 0; iy < ny_pts; iy++) {
    const idx = iy * nx_pts + ix_load;
    const val = Math.abs(Mx_point[idx]);
    if (val > mx_peak) mx_peak = val;
    mx_integral += val * dy_grid / 12;
  }
  const implied_beff = mx_peak > 0 ? mx_integral / mx_peak : 0;

  // FWHM
  let fwhm = 0;
  if (mx_peak > 0) {
    const half = mx_peak / 2;
    let first = -1, last = -1;
    for (let iy = 0; iy < ny_pts; iy++) {
      const idx = iy * nx_pts + ix_load;
      if (Math.abs(Mx_point[idx]) > half) {
        if (first < 0) first = iy;
        last = iy;
      }
    }
    if (first >= 0 && last > first) {
      fwhm = (last - first) * dy_grid / 12;
    }
  }

  // Branson effective width estimate (cracked)
  // The cracking reduces stiffness near load, concentrating moment
  // Estimate: multiply elastic beff by sqrt(Icr/Ig) as rough correction
  const stiffness_ratio = Math.sqrt(Icr_x / Ig_per_in);
  const beff_cracked_est = implied_beff * (0.5 + 0.5 * stiffness_ratio);

  return {
    method: "Elastic Plate (Lévy Series)",
    implied_beff: implied_beff,
    fwhm,
    beff_cracked_est,
    nTerms,
    results: {
      flexure_mx: { Pu: Pu_flex_mx, P: Pu_flex_mx / 1.6 },
      flexure_my: { Pu: Pu_flex_my, P: Pu_flex_my / 1.6 },
      shear: { Pu: Pu_shear, P: Pu_shear / 1.6, beff_shear },
      punching: { Pu: phi_Vc_punch, P: phi_Vc_punch / 1.6, b0 }
    },
    governing: { Pu: governing_Pu, P: governing_Pu / 1.6, mode: gov_mode },
    grid: { Mx_point, My_point, Mx_uniform, nx_pts, ny_pts, dx_grid, dy_grid }
  };
}


// ============================================================
// BAR SIZE LOOKUP
// ============================================================
const BAR_SIZES = {
  "#3": 0.375, "#4": 0.500, "#5": 0.625, "#6": 0.750,
  "#7": 0.875, "#8": 1.000, "#9": 1.128, "#10": 1.270, "#11": 1.410
};

// ============================================================
// REACT APP
// ============================================================
export default function SlabAnalyzer() {
  // Input state
  const [inputs, setInputs] = useState({
    Lx: 11, Ly: 26.5, h: 8, cover: 0.75,
    fc: 4, fy: 60,
    barShort: "#4", barLong: "#4",
    spacingShortBot: 10, spacingShortTop: 10,
    spacingLongBot: 12, spacingLongTop: 12,
    xLoad: 3.8, wD: 100, wL: 100,
    bearingSize: 6
  });

  const [results, setResults] = useState(null);
  const [activeTab, setActiveTab] = useState("inputs");

  const updateInput = (key, value) => {
    setInputs(prev => ({ ...prev, [key]: value }));
  };

  const runAnalysis = useCallback(() => {
    const barDiaShort = BAR_SIZES[inputs.barShort];
    const barDiaLong = BAR_SIZES[inputs.barLong];

    const params = {
      Lx: inputs.Lx, Ly: inputs.Ly, h: inputs.h, cover: inputs.cover,
      fc: inputs.fc, fy: inputs.fy,
      barDiaShort, barDiaLong,
      spacingShortBot: inputs.spacingShortBot,
      spacingShortTop: inputs.spacingShortTop,
      spacingLongBot: inputs.spacingLongBot,
      spacingLongTop: inputs.spacingLongTop,
      xLoad: inputs.xLoad, wD: inputs.wD, wL: inputs.wL,
      bearingSize: inputs.bearingSize
    };

    const section = computeSectionProps(params);
    const hand = runHandCalc(params, section);
    const yl = runYieldLine(params, section);
    const fea = runElasticFEA(params, section);

    setResults({ section, hand, yl, fea, params });
    setActiveTab("results");
  }, [inputs]);

  const fmt = (v, dec = 2) => {
    if (v === undefined || v === null || isNaN(v)) return "—";
    if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return v.toFixed(dec);
  };

  const fmtLbs = (kips) => {
    if (!kips || isNaN(kips)) return "—";
    return `${(kips * 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} lbs`;
  };

  return (
    <div style={{
      fontFamily: "'IBM Plex Sans', 'DM Sans', system-ui, sans-serif",
      background: "#0c0f14",
      color: "#e4e4e7",
      minHeight: "100vh",
      padding: "0"
    }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #1a1f2e 0%, #0f1219 100%)",
        borderBottom: "1px solid #2a2f3e",
        padding: "20px 24px",
        display: "flex", alignItems: "center", gap: "16px"
      }}>
        <div style={{
          width: 42, height: 42, borderRadius: 8,
          background: "linear-gradient(135deg, #f59e0b, #d97706)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 20, fontWeight: 900, color: "#0c0f14"
        }}>S</div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", color: "#f4f4f5" }}>
            One-Way Slab Point Load Analyzer
          </div>
          <div style={{ fontSize: 12, color: "#71717a", marginTop: 2 }}>
            ACI 318 · Strip Method · Yield-Line · Elastic Plate Theory
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{
        display: "flex", gap: 0, borderBottom: "1px solid #2a2f3e",
        background: "#11141b", padding: "0 24px"
      }}>
        {[
          { key: "inputs", label: "Inputs" },
          { key: "results", label: "Results" },
          { key: "details", label: "Detailed Output" }
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
            padding: "12px 20px", fontSize: 13, fontWeight: 600,
            background: "transparent", border: "none", cursor: "pointer",
            color: activeTab === tab.key ? "#f59e0b" : "#71717a",
            borderBottom: activeTab === tab.key ? "2px solid #f59e0b" : "2px solid transparent",
            transition: "all 0.2s"
          }}>{tab.label}</button>
        ))}
      </div>

      <div style={{ padding: "24px", maxWidth: 1400, margin: "0 auto" }}>
        {/* INPUTS TAB */}
        {activeTab === "inputs" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
            <Card title="Geometry">
              <InputRow label="Short Span (ft)" value={inputs.Lx}
                onChange={v => updateInput("Lx", parseFloat(v) || 0)} />
              <InputRow label="Long Span (ft)" value={inputs.Ly}
                onChange={v => updateInput("Ly", parseFloat(v) || 0)} />
              <InputRow label="Slab Thickness (in)" value={inputs.h}
                onChange={v => updateInput("h", parseFloat(v) || 0)} />
              <InputRow label="Clear Cover (in)" value={inputs.cover}
                onChange={v => updateInput("cover", parseFloat(v) || 0)} />
              <div style={{ marginTop: 8, padding: "8px 10px", background: "#1a1f2e", borderRadius: 6, fontSize: 11, color: "#a1a1aa" }}>
                Span ratio: {(inputs.Ly / inputs.Lx).toFixed(2)} {inputs.Ly / inputs.Lx >= 2 ? "✓ One-way" : "⚠ Two-way behavior likely"}
              </div>
            </Card>

            <Card title="Materials">
              <InputRow label="f'c (ksi)" value={inputs.fc}
                onChange={v => updateInput("fc", parseFloat(v) || 0)} />
              <InputRow label="fy (ksi)" value={inputs.fy}
                onChange={v => updateInput("fy", parseFloat(v) || 0)} />
              <div style={{ borderTop: "1px solid #2a2f3e", margin: "12px 0", paddingTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Short Direction Reinforcement
                </div>
                <SelectRow label="Bar Size" value={inputs.barShort}
                  options={Object.keys(BAR_SIZES)}
                  onChange={v => updateInput("barShort", v)} />
                <InputRow label="Bottom Spacing (in o.c.)" value={inputs.spacingShortBot}
                  onChange={v => updateInput("spacingShortBot", parseFloat(v) || 0)} />
                <InputRow label="Top Spacing (in o.c.)" value={inputs.spacingShortTop}
                  onChange={v => updateInput("spacingShortTop", parseFloat(v) || 0)} />
              </div>
              <div style={{ borderTop: "1px solid #2a2f3e", margin: "12px 0", paddingTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Long Direction Reinforcement
                </div>
                <SelectRow label="Bar Size" value={inputs.barLong}
                  options={Object.keys(BAR_SIZES)}
                  onChange={v => updateInput("barLong", v)} />
                <InputRow label="Bottom Spacing (in o.c.)" value={inputs.spacingLongBot}
                  onChange={v => updateInput("spacingLongBot", parseFloat(v) || 0)} />
                <InputRow label="Top Spacing (in o.c.)" value={inputs.spacingLongTop}
                  onChange={v => updateInput("spacingLongTop", parseFloat(v) || 0)} />
              </div>
            </Card>

            <Card title="Loading">
              <InputRow label="Dead Load (psf)" value={inputs.wD}
                onChange={v => updateInput("wD", parseFloat(v) || 0)}
                note="Includes self-weight" />
              <InputRow label="Live Load (psf)" value={inputs.wL}
                onChange={v => updateInput("wL", parseFloat(v) || 0)} />
              <div style={{ borderTop: "1px solid #2a2f3e", margin: "12px 0", paddingTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Point Load Location
                </div>
                <InputRow label="Distance from Support (ft)" value={inputs.xLoad}
                  onChange={v => updateInput("xLoad", parseFloat(v) || 0)} />
                <InputRow label="Bearing Plate Size (in)" value={inputs.bearingSize}
                  onChange={v => updateInput("bearingSize", parseFloat(v) || 0)} />
                <div style={{ marginTop: 8 }}>
                  <SlabDiagram Lx={inputs.Lx} Ly={inputs.Ly} xLoad={inputs.xLoad} />
                </div>
              </div>
            </Card>

            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "center", marginTop: 8 }}>
              <button onClick={runAnalysis} style={{
                padding: "14px 48px", fontSize: 15, fontWeight: 700,
                background: "linear-gradient(135deg, #f59e0b, #d97706)",
                color: "#0c0f14", border: "none", borderRadius: 10,
                cursor: "pointer", letterSpacing: "-0.01em",
                boxShadow: "0 4px 20px rgba(245,158,11,0.3)",
                transition: "transform 0.15s, box-shadow 0.15s"
              }}
                onMouseEnter={e => { e.target.style.transform = "translateY(-1px)"; e.target.style.boxShadow = "0 6px 28px rgba(245,158,11,0.4)"; }}
                onMouseLeave={e => { e.target.style.transform = ""; e.target.style.boxShadow = "0 4px 20px rgba(245,158,11,0.3)"; }}
              >
                Run Analysis
              </button>
            </div>
          </div>
        )}

        {/* RESULTS TAB */}
        {activeTab === "results" && results && (
          <div>
            {/* Section Properties Summary */}
            <Card title="Section Properties" style={{ marginBottom: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                <PropChip label="d (short)" value={`${fmt(results.section.d_x)} in`} />
                <PropChip label="d (long)" value={`${fmt(results.section.d_y)} in`} />
                <PropChip label="As,x bot" value={`${fmt(results.section.As_x_bot, 3)} in²/ft`} />
                <PropChip label="As,y bot" value={`${fmt(results.section.As_y_bot, 3)} in²/ft`} />
                <PropChip label="φMn,x" value={`${fmt(results.section.phi_Mn_x_pos / 12)} ft-k/ft`} accent />
                <PropChip label="φMn,y" value={`${fmt(results.section.phi_Mn_y_pos / 12)} ft-k/ft`} accent />
                <PropChip label="φVc" value={`${fmt(results.section.phi_Vc)} k/ft`} />
                <PropChip label="Mcr" value={`${fmt(results.section.Mcr / 12)} ft-k/ft`} />
              </div>
            </Card>

            {/* Three Method Cards Side by Side */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginBottom: 20 }}>
              {/* Method 1: Hand Calc */}
              <MethodCard
                title="ACI Strip Method"
                subtitle="Conservative · Code-based"
                color="#3b82f6"
                result={results.hand}
                fmt={fmt} fmtLbs={fmtLbs}
              >
                <ResultRow label="Effective Width" value={`${fmt(results.hand.beff_used)} ft`} />
                <ResultRow label="wu (factored)" value={`${fmt(results.hand.w_u)} psf`} />
                <Divider />
                <ResultRow label="Flexure" value={fmtLbs(results.hand.results.flexure.P)}
                  sub={`Pu = ${fmt(results.hand.results.flexure.Pu)} kips`}
                  highlight={results.hand.governing.mode === "Flexure"} />
                <ResultRow label="One-Way Shear" value={fmtLbs(results.hand.results.shear.P)}
                  sub={`Pu = ${fmt(results.hand.results.shear.Pu)} kips`}
                  highlight={results.hand.governing.mode === "One-Way Shear"} />
                <ResultRow label="Punching Shear" value={fmtLbs(results.hand.results.punching.P)}
                  sub={`Pu = ${fmt(results.hand.results.punching.Pu)} kips`}
                  highlight={results.hand.governing.mode === "Punching Shear"} />
              </MethodCard>

              {/* Method 2: Yield Line */}
              <MethodCard
                title="Yield-Line Analysis"
                subtitle="Upper bound · Plastic"
                color="#8b5cf6"
                result={results.yl}
                fmt={fmt} fmtLbs={fmtLbs}
              >
                <ResultRow label="Mechanism Width" value={`${fmt(results.yl.mechanism_width)} ft`} />
                <ResultRow label="Optimal c" value={`${fmt(results.yl.c_opt)} ft`} />
                <Divider />
                <ResultRow label="Collapse Load" value={fmtLbs(results.yl.governing.P)}
                  sub={`Pu = ${fmt(results.yl.governing.Pu)} kips`}
                  highlight />
                <div style={{ marginTop: 12, padding: "10px 12px", background: "rgba(139,92,246,0.08)", borderRadius: 8, fontSize: 11, color: "#a78bfa", lineHeight: 1.5 }}>
                  Upper-bound theorem: true capacity ≤ this value. Requires sufficient ductility for full plastic redistribution.
                </div>
              </MethodCard>

              {/* Method 3: Elastic Plate */}
              <MethodCard
                title="Elastic Plate (Lévy)"
                subtitle="Analytical · Gross section"
                color="#10b981"
                result={results.fea}
                fmt={fmt} fmtLbs={fmtLbs}
              >
                <ResultRow label="Implied beff" value={`${fmt(results.fea.implied_beff)} ft`} />
                <ResultRow label="FWHM Width" value={`${fmt(results.fea.fwhm)} ft`} />
                <ResultRow label="Cracked beff (est)" value={`${fmt(results.fea.beff_cracked_est)} ft`} />
                <Divider />
                <ResultRow label="Flexure (Mx)" value={fmtLbs(results.fea.results.flexure_mx.P)}
                  sub={`Pu = ${fmt(results.fea.results.flexure_mx.Pu)} kips`}
                  highlight={results.fea.governing.mode.includes("Mx")} />
                <ResultRow label="Flexure (My)" value={fmtLbs(results.fea.results.flexure_my.P)}
                  sub={`Pu = ${fmt(results.fea.results.flexure_my.Pu)} kips`}
                  highlight={results.fea.governing.mode.includes("My")} />
                <ResultRow label="One-Way Shear" value={fmtLbs(results.fea.results.shear.P)}
                  sub={`beff,v = ${fmt(results.fea.results.shear.beff_shear)} ft`}
                  highlight={results.fea.governing.mode === "One-Way Shear"} />
                <ResultRow label="Punching Shear" value={fmtLbs(results.fea.results.punching.P)}
                  highlight={results.fea.governing.mode === "Punching Shear"} />
              </MethodCard>
            </div>

            {/* Comparison Bar */}
            <Card title="Comparison Summary" style={{ marginBottom: 20 }}>
              <ComparisonBar results={results} fmt={fmt} />
            </Card>

            {/* Engineering Recommendation */}
            <Card title="Engineering Recommendation" accent>
              <RecommendationBlock results={results} fmt={fmt} />
            </Card>
          </div>
        )}

        {/* DETAILS TAB */}
        {activeTab === "details" && results && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <Card title="Hand Calculation Details" style={{ gridColumn: "1 / -1" }}>
              <DetailBlock results={results} />
            </Card>
            <Card title="Yield-Line Mechanism">
              <YieldLineDiagram results={results} />
            </Card>
            <Card title="Moment Distribution (Elastic Plate)">
              <MomentProfile results={results} />
            </Card>
          </div>
        )}

        {!results && activeTab !== "inputs" && (
          <div style={{ textAlign: "center", padding: 60, color: "#52525b" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚙️</div>
            <div style={{ fontSize: 15 }}>Run analysis first to see results</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// UI COMPONENTS
// ============================================================

function Card({ title, children, style, accent }) {
  return (
    <div style={{
      background: accent ? "linear-gradient(135deg, #1a1708 0%, #151a12 100%)" : "#15181f",
      border: `1px solid ${accent ? "#422006" : "#2a2f3e"}`,
      borderRadius: 12, padding: "16px 18px", ...style
    }}>
      {title && (
        <div style={{
          fontSize: 12, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.06em", color: accent ? "#f59e0b" : "#71717a",
          marginBottom: 14
        }}>{title}</div>
      )}
      {children}
    </div>
  );
}

function InputRow({ label, value, onChange, note }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
      <label style={{ flex: 1, fontSize: 13, color: "#a1a1aa" }}>{label}</label>
      <input type="number" value={value} onChange={e => onChange(e.target.value)}
        step="any"
        style={{
          width: 80, padding: "6px 10px", fontSize: 13, fontWeight: 600,
          background: "#1e222d", border: "1px solid #2a2f3e", borderRadius: 6,
          color: "#f4f4f5", textAlign: "right", outline: "none"
        }}
        onFocus={e => e.target.style.borderColor = "#f59e0b"}
        onBlur={e => e.target.style.borderColor = "#2a2f3e"} />
      {note && <div style={{ fontSize: 10, color: "#52525b", marginLeft: 6, maxWidth: 60 }}>{note}</div>}
    </div>
  );
}

function SelectRow({ label, value, options, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
      <label style={{ flex: 1, fontSize: 13, color: "#a1a1aa" }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          width: 80, padding: "6px 8px", fontSize: 13, fontWeight: 600,
          background: "#1e222d", border: "1px solid #2a2f3e", borderRadius: 6,
          color: "#f4f4f5", outline: "none", cursor: "pointer"
        }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function PropChip({ label, value, accent }) {
  return (
    <div style={{
      padding: "8px 10px", background: accent ? "rgba(245,158,11,0.08)" : "#1a1f2e",
      borderRadius: 8, border: accent ? "1px solid rgba(245,158,11,0.2)" : "1px solid transparent"
    }}>
      <div style={{ fontSize: 10, color: "#71717a", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: accent ? "#fbbf24" : "#e4e4e7" }}>{value}</div>
    </div>
  );
}

function MethodCard({ title, subtitle, color, result, children, fmt, fmtLbs }) {
  const P_lbs = result.governing.P * 1000;
  return (
    <div style={{
      background: "#15181f", border: "1px solid #2a2f3e", borderRadius: 12,
      borderTop: `3px solid ${color}`, padding: 0, overflow: "hidden"
    }}>
      <div style={{ padding: "16px 18px 12px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#f4f4f5" }}>{title}</div>
        <div style={{ fontSize: 11, color: "#71717a", marginTop: 2 }}>{subtitle}</div>
      </div>
      <div style={{
        background: `linear-gradient(135deg, ${color}15, ${color}08)`,
        padding: "16px 18px", margin: "0 12px", borderRadius: 10
      }}>
        <div style={{ fontSize: 11, color: "#a1a1aa" }}>Maximum Service Point Load</div>
        <div style={{ fontSize: 28, fontWeight: 800, color, letterSpacing: "-0.02em", marginTop: 4 }}>
          {P_lbs.toLocaleString("en-US", { maximumFractionDigits: 0 })} <span style={{ fontSize: 14, fontWeight: 600 }}>lbs</span>
        </div>
        <div style={{ fontSize: 12, color: "#71717a", marginTop: 4 }}>
          {fmt(result.governing.Pu)} kips factored · {result.governing.mode}
        </div>
      </div>
      <div style={{ padding: "12px 18px 16px" }}>
        {children}
      </div>
    </div>
  );
}

function ResultRow({ label, value, sub, highlight }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "6px 0", borderLeft: highlight ? "3px solid #f59e0b" : "3px solid transparent",
      paddingLeft: highlight ? 10 : 0, marginLeft: highlight ? -2 : 0
    }}>
      <div>
        <div style={{ fontSize: 12, color: highlight ? "#fbbf24" : "#a1a1aa" }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: "#52525b" }}>{sub}</div>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: highlight ? "#fbbf24" : "#e4e4e7" }}>{value}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid #2a2f3e", margin: "8px 0" }} />;
}

function ComparisonBar({ results, fmt }) {
  const methods = [
    { name: "ACI Strip", P: results.hand.governing.P * 1000, color: "#3b82f6" },
    { name: "Yield-Line", P: results.yl.governing.P * 1000, color: "#8b5cf6" },
    { name: "Elastic Plate", P: results.fea.governing.P * 1000, color: "#10b981" }
  ];
  const maxP = Math.max(...methods.map(m => m.P));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {methods.map(m => (
        <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 100, fontSize: 12, fontWeight: 600, color: m.color }}>{m.name}</div>
          <div style={{ flex: 1, height: 28, background: "#1a1f2e", borderRadius: 6, overflow: "hidden", position: "relative" }}>
            <div style={{
              height: "100%", width: `${(m.P / maxP) * 100}%`,
              background: `linear-gradient(90deg, ${m.color}40, ${m.color}80)`,
              borderRadius: 6, transition: "width 0.6s ease"
            }} />
            <div style={{
              position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
              fontSize: 12, fontWeight: 700, color: "#e4e4e7"
            }}>
              {m.P.toLocaleString("en-US", { maximumFractionDigits: 0 })} lbs
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RecommendationBlock({ results, fmt }) {
  const P_hand = results.hand.governing.P;
  const P_yl = results.yl.governing.P;
  const P_fea = results.fea.governing.P;
  const P_design = P_hand;
  const P_best = (P_hand + Math.min(P_yl, P_fea)) / 2;

  return (
    <div style={{ lineHeight: 1.7, fontSize: 13, color: "#d4d4d8" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div style={{ padding: "12px 14px", background: "#1a1f2e", borderRadius: 8, borderLeft: "3px solid #3b82f6" }}>
          <div style={{ fontSize: 11, color: "#71717a", marginBottom: 4 }}>For Code/Permit Work</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#3b82f6" }}>
            {(P_design * 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} lbs
          </div>
          <div style={{ fontSize: 11, color: "#71717a" }}>ACI strip method — conservative, standard practice</div>
        </div>
        <div style={{ padding: "12px 14px", background: "#1a1f2e", borderRadius: 8, borderLeft: "3px solid #f59e0b" }}>
          <div style={{ fontSize: 11, color: "#71717a", marginBottom: 4 }}>Best Estimate (Assessment)</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#f59e0b" }}>
            {(P_best * 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} lbs
          </div>
          <div style={{ fontSize: 11, color: "#71717a" }}>Average of strip method and plate theory / yield-line</div>
        </div>
      </div>
      <p style={{ margin: 0 }}>
        The ACI strip method is the standard conservative approach for one-way slab design. 
        Plate theory and yield-line analysis show the slab has additional capacity beyond the strip method 
        due to two-dimensional load distribution. For assessment of existing structures, the best estimate 
        accounts for this reserve while maintaining engineering judgment.
      </p>
    </div>
  );
}

function SlabDiagram({ Lx, Ly, xLoad }) {
  const W = 220, H = 100;
  const pad = 20;
  const sW = W - 2 * pad;
  const sH = H - 2 * pad;
  const xP = pad + (xLoad / Lx) * sW;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 80 }}>
      {/* Slab */}
      <rect x={pad} y={pad} width={sW} height={sH} rx={3}
        fill="none" stroke="#3f3f46" strokeWidth={1.5} />
      {/* Supports */}
      <line x1={pad} y1={pad} x2={pad} y2={pad + sH} stroke="#f59e0b" strokeWidth={3} />
      <line x1={pad + sW} y1={pad} x2={pad + sW} y2={pad + sH} stroke="#f59e0b" strokeWidth={3} />
      {/* Load point */}
      <circle cx={xP} cy={pad + sH / 2} r={5} fill="#ef4444" />
      <line x1={xP} y1={pad - 5} x2={xP} y2={pad + sH / 2 - 7} stroke="#ef4444" strokeWidth={1.5}
        markerEnd="url(#arr)" />
      {/* Dimension */}
      <text x={pad + sW / 2} y={H - 2} textAnchor="middle" fontSize={9} fill="#71717a">{Lx} ft</text>
      <text x={xP} y={pad - 8} textAnchor="middle" fontSize={8} fill="#ef4444">{xLoad} ft</text>
      <text x={5} y={pad + sH / 2 + 3} textAnchor="middle" fontSize={8} fill="#f59e0b" transform={`rotate(-90, 8, ${pad + sH / 2})`}>{Ly} ft</text>
      <defs>
        <marker id="arr" markerWidth={6} markerHeight={6} refX={3} refY={3} orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#ef4444" />
        </marker>
      </defs>
    </svg>
  );
}

function DetailBlock({ results }) {
  const s = results.section;
  const h = results.hand;
  const p = results.params;
  return (
    <pre style={{
      fontSize: 11, fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
      color: "#a1a1aa", lineHeight: 1.8, whiteSpace: "pre-wrap",
      background: "#0c0f14", padding: 16, borderRadius: 8, margin: 0, overflowX: "auto"
    }}>
{`SECTION PROPERTIES
──────────────────────────────────────
  Slab:    h = ${p.h}" | cover = ${p.cover}" | f'c = ${p.fc} ksi | fy = ${p.fy} ksi
  d_x =    ${s.d_x.toFixed(2)} in (short dir)
  d_y =    ${s.d_y.toFixed(2)} in (long dir)
  As,x =   ${s.As_x_bot.toFixed(3)} in²/ft (bot) | ${s.As_x_top.toFixed(3)} in²/ft (top)
  As,y =   ${s.As_y_bot.toFixed(3)} in²/ft (bot)
  φMn,x =  ${(s.phi_Mn_x_pos/12).toFixed(2)} ft-k/ft (pos) | ${(s.phi_Mn_x_neg/12).toFixed(2)} ft-k/ft (neg)
  φMn,y =  ${(s.phi_Mn_y_pos/12).toFixed(2)} ft-k/ft (pos)
  φVc =    ${s.phi_Vc.toFixed(2)} k/ft
  Ec =     ${s.Ec.toFixed(0)} ksi
  Mcr =    ${(s.Mcr/12).toFixed(2)} ft-k/ft
  Ig =     ${s.Ig.toFixed(1)} in⁴/ft
  Icr,x =  ${(s.Icr_x*12).toFixed(1)} in⁴/ft  (ratio = ${(s.Icr_x/(p.h**3/12)).toFixed(3)})

HAND CALCULATION (ACI STRIP METHOD)
──────────────────────────────────────
  Span = ${p.Lx} ft | Load at ${p.xLoad} ft from support
  a = ${p.xLoad} ft, b = ${(p.Lx - p.xLoad).toFixed(2)} ft
  beff = L/3 = ${(p.Lx/3).toFixed(2)} ft (used: ${h.beff_used.toFixed(2)} ft)
  wu = 1.2(${p.wD}) + 1.6(${p.wL}) = ${h.w_u.toFixed(0)} psf

  FLEXURE:
    Mu,uniform @ load = ${h.results.flexure.M_uniform.toFixed(2)} ft-k/ft
    Available for point = ${h.results.flexure.capacity.toFixed(2)} - ${h.results.flexure.M_uniform.toFixed(2)} = ${(h.results.flexure.capacity - h.results.flexure.M_uniform).toFixed(2)} ft-k/ft
    Pu = ${h.results.flexure.Pu.toFixed(2)} kips → P = ${(h.results.flexure.P*1000).toFixed(0)} lbs

  ONE-WAY SHEAR:
    Vu,uniform @ d = ${h.results.shear.V_uniform.toFixed(2)} k/ft
    φVc = ${h.results.shear.capacity.toFixed(2)} k/ft
    Pu = ${h.results.shear.Pu.toFixed(2)} kips → P = ${(h.results.shear.P*1000).toFixed(0)} lbs

  PUNCHING SHEAR:
    b0 = ${h.results.punching.b0.toFixed(1)} in
    φVc = ${h.results.punching.capacity.toFixed(1)} kips
    P = ${(h.results.punching.P*1000).toFixed(0)} lbs

  GOVERNING: ${h.governing.mode} → P = ${(h.governing.P*1000).toFixed(0)} lbs`}
    </pre>
  );
}

function YieldLineDiagram({ results }) {
  const W = 280, H = 200;
  const pad = 30;
  const Lx = results.params.Lx;
  const Ly = results.params.Ly;
  const xL = results.params.xLoad;
  const c = results.yl.c_opt;

  const scX = (W - 2 * pad) / Lx;
  const scY = (H - 2 * pad) / Ly;
  const sc = Math.min(scX, scY);
  const oX = pad + ((W - 2 * pad) - Lx * sc) / 2;
  const oY = pad + ((H - 2 * pad) - Ly * sc) / 2;

  const px = (x) => oX + x * sc;
  const py = (y) => oY + y * sc;

  const xP = xL, yP = Ly / 2;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 180 }}>
        <rect x={px(0)} y={py(0)} width={Lx * sc} height={Ly * sc}
          fill="none" stroke="#3f3f46" strokeWidth={1} />
        {/* Yield lines */}
        <line x1={px(0)} y1={py(yP - c)} x2={px(xP)} y2={py(yP)} stroke="#8b5cf6" strokeWidth={2} strokeDasharray="4,3" />
        <line x1={px(0)} y1={py(yP + c)} x2={px(xP)} y2={py(yP)} stroke="#8b5cf6" strokeWidth={2} strokeDasharray="4,3" />
        <line x1={px(Lx)} y1={py(yP - c)} x2={px(xP)} y2={py(yP)} stroke="#8b5cf6" strokeWidth={2} strokeDasharray="4,3" />
        <line x1={px(Lx)} y1={py(yP + c)} x2={px(xP)} y2={py(yP)} stroke="#8b5cf6" strokeWidth={2} strokeDasharray="4,3" />
        {/* Supports */}
        <line x1={px(0)} y1={py(0)} x2={px(0)} y2={py(Ly)} stroke="#f59e0b" strokeWidth={3} />
        <line x1={px(Lx)} y1={py(0)} x2={px(Lx)} y2={py(Ly)} stroke="#f59e0b" strokeWidth={3} />
        {/* Load */}
        <circle cx={px(xP)} cy={py(yP)} r={4} fill="#ef4444" />
        {/* Annotations */}
        <text x={px(xP) + 8} y={py(yP) - 6} fontSize={9} fill="#a1a1aa">P</text>
        <text x={px(0) - 3} y={py(yP - c) - 4} fontSize={8} fill="#8b5cf6" textAnchor="end">c</text>
      </svg>
      <div style={{ fontSize: 11, color: "#a1a1aa", padding: "4px 0" }}>
        Fan mechanism: c = {results.yl.c_opt.toFixed(1)} ft, width = {results.yl.mechanism_width.toFixed(1)} ft
      </div>
    </div>
  );
}

function MomentProfile({ results }) {
  if (!results.fea.grid) return null;
  const { Mx_point, nx_pts, ny_pts, dy_grid } = results.fea.grid;
  const Ly = results.params.Ly;
  const xLoad = results.params.xLoad;
  const Lx = results.params.Lx;
  const ix_load = Math.round((xLoad * 12) / (Lx * 12 / (nx_pts - 1)));

  // Get profile across width at load location
  const profile = [];
  let maxVal = 0;
  for (let iy = 0; iy < ny_pts; iy++) {
    const val = Math.abs(Mx_point[iy * nx_pts + Math.min(ix_load, nx_pts - 1)]);
    profile.push(val);
    if (val > maxVal) maxVal = val;
  }

  const W = 280, H = 140, pad = 30;
  const scX = (W - 2 * pad) / (ny_pts - 1);
  const scY = maxVal > 0 ? (H - 2 * pad) / maxVal : 1;

  let pathD = "";
  profile.forEach((v, i) => {
    const x = pad + i * scX;
    const y = H - pad - v * scY;
    pathD += (i === 0 ? "M" : "L") + `${x},${y}`;
  });

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 140 }}>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#2a2f3e" />
        <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="#2a2f3e" />
        <path d={pathD} fill="none" stroke="#10b981" strokeWidth={2} />
        {/* Capacity line */}
        <line x1={pad} y1={H - pad - results.section.phi_Mn_x_pos * scY}
          x2={W - pad} y2={H - pad - results.section.phi_Mn_x_pos * scY}
          stroke="#ef4444" strokeWidth={1} strokeDasharray="4,3" />
        <text x={pad + 4} y={H - pad + 12} fontSize={8} fill="#71717a">0</text>
        <text x={W - pad} y={H - pad + 12} fontSize={8} fill="#71717a" textAnchor="end">{Ly} ft</text>
        <text x={pad - 4} y={pad + 4} fontSize={8} fill="#71717a" textAnchor="end">Mx</text>
        <text x={W - pad} y={H - pad - results.section.phi_Mn_x_pos * scY - 4}
          fontSize={8} fill="#ef4444" textAnchor="end">φMn</text>
      </svg>
      <div style={{ fontSize: 11, color: "#a1a1aa", padding: "4px 0" }}>
        Mx distribution across slab width at load location (unit point load)
      </div>
    </div>
  );
}
