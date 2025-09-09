// math/linreg.ts
export function computeLinearFit(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 2) return { m: NaN, b: NaN, r2: NaN, reason: "n<2" };

  const xMean = xs.reduce((a,b)=>a+b,0)/n;
  const yMean = ys.reduce((a,b)=>a+b,0)/n;

  let Sxx=0, Sxy=0, Syy=0;
  for (let i=0;i<n;i++){
    const dx = xs[i]-xMean;
    const dy = ys[i]-yMean;
    Sxx += dx*dx;
    Sxy += dx*dy;
    Syy += dy*dy;
  }
  if (Sxx === 0) return { m: NaN, b: NaN, r2: NaN, reason: "vertical" };

  const m = Sxy / Sxx;
  const b = yMean - m * xMean;

  let ssRes=0;
  for (let i=0;i<n;i++){
    const yhat = m*xs[i] + b;
    const resid = ys[i]-yhat;
    ssRes += resid*resid;
  }
  const ssTot = Syy;
  const r2 = ssTot === 0 ? NaN : 1 - ssRes/ssTot;

  return { m, b, r2, reason: null };
}
