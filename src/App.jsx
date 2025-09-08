import React, { useRef, useState } from "react";

// Face-Placement-Scorer
// Single-file React component. Tailwind CSS assumed available in the page.
// Workflow:
// 1) Upload reference image (complete face) and photo (wall with placed parts / or take with phone)
// 2) Calibrate by clicking 4 matching corner points on reference image and on photo
// 3) Mark ground-truth keypoints on reference (eyes, brows, nose, mouth)
// 4) Mark participant placements on photo in the same order
// 5) Compute homography, map photo points into reference coords, compute distances

export default function FacePlacementScorer() {
  const refCanvas = useRef(null);
  const photoCanvas = useRef(null);
  const [refImage, setRefImage] = useState(null);
  const [photoImage, setPhotoImage] = useState(null);
  const [mode, setMode] = useState("idle");

  // Calibration points (4 corners)
  const [refCalPts, setRefCalPts] = useState([]);
  const [photoCalPts, setPhotoCalPts] = useState([]);

  // Keypoints: user-defined list of named parts
  const defaultParts = ["Left Eye","Right Eye","Nose Tip","Mouth Center","Left Brow","Right Brow"];
  const [parts, setParts] = useState(defaultParts);
  const [refPartsPts, setRefPartsPts] = useState([]);
  const [photoPartsPts, setPhotoPartsPts] = useState([]);

  const [homography, setHomography] = useState(null);
  const [results, setResults] = useState(null);
  const [physicalWidthCm, setPhysicalWidthCm] = useState(100);

  // Utility: draw image onto canvas
  function drawImageToCanvas(img, canvasRef) {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.clearRect(0,0,canvas.width, canvas.height);
    ctx.drawImage(img, 0,0);
  }

  // When images load, draw them
  function handleRefUpload(e) {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { setRefImage(img); setRefCalPts([]); setRefPartsPts([]); }
    img.src = URL.createObjectURL(f);
  }
  function handlePhotoUpload(e) {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { setPhotoImage(img); setPhotoCalPts([]); setPhotoPartsPts([]); }
    img.src = URL.createObjectURL(f);
  }

  // Keep canvases updated
  React.useEffect(() => { drawImageToCanvas(refImage, refCanvas); }, [refImage]);
  React.useEffect(() => { drawImageToCanvas(photoImage, photoCanvas); }, [photoImage]);
  React.useEffect(() => { redrawAll(); }, [refCalPts, photoCalPts, refPartsPts, photoPartsPts, homography]);

  // Canvas click handlers
  function onRefCanvasClick(e) {
    if (!refCanvas.current) return;
    const rect = refCanvas.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (refCanvas.current.width / rect.width);
    const y = (e.clientY - rect.top) * (refCanvas.current.height / rect.height);

    if (mode === "calibrate-ref") {
      if (refCalPts.length < 4) setRefCalPts([...refCalPts, [x,y]]);
    } else if (mode === "mark-ref") {
      if (refPartsPts.length < parts.length) setRefPartsPts([...refPartsPts, [x,y]]);
    }
  }
  function onPhotoCanvasClick(e) {
    if (!photoCanvas.current) return;
    const rect = photoCanvas.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (photoCanvas.current.width / rect.width);
    const y = (e.clientY - rect.top) * (photoCanvas.current.height / rect.height);

    if (mode === "calibrate-photo") {
      if (photoCalPts.length < 4) setPhotoCalPts([...photoCalPts, [x,y]]);
    } else if (mode === "mark-photo") {
      if (photoPartsPts.length < parts.length) setPhotoPartsPts([...photoPartsPts, [x,y]]);
    }
  }

  // Redraw overlays
  function redrawAll() {
    const rc = refCanvas.current; const pc = photoCanvas.current;
    if (rc && refImage) {
      const ctx = rc.getContext("2d");
      ctx.clearRect(0,0,rc.width, rc.height);
      ctx.drawImage(refImage,0,0);
      // draw calibration
      ctx.fillStyle = "rgba(0,200,0,0.8)";
      refCalPts.forEach((p,i)=>{ drawCircle(ctx,p[0],p[1],6); drawText(ctx, `${i+1}`, p[0]+8, p[1]-8); });
      // draw ref parts
      ctx.fillStyle = "rgba(0,0,200,0.9)";
      refPartsPts.forEach((p,i)=>{ drawCircle(ctx,p[0],p[1],6); drawText(ctx, parts[i], p[0]+8, p[1]-8); });
    }
    if (pc && photoImage) {
      const ctx = pc.getContext("2d");
      ctx.clearRect(0,0,pc.width, pc.height);
      ctx.drawImage(photoImage,0,0);
      ctx.fillStyle = "rgba(200,0,0,0.8)";
      photoCalPts.forEach((p,i)=>{ drawCircle(ctx,p[0],p[1],6); drawText(ctx, `${i+1}`, p[0]+8, p[1]-8); });
      ctx.fillStyle = "rgba(0,0,200,0.9)";
      photoPartsPts.forEach((p,i)=>{ drawCircle(ctx,p[0],p[1],6); drawText(ctx, parts[i], p[0]+8, p[1]-8); });

      // If homography exists, map ref points onto photo to visualize
      if (homography && refPartsPts.length>0) {
        const H = homography;
        ctx.strokeStyle = "rgba(0,200,0,0.9)";
        ctx.lineWidth = 2;
        refPartsPts.forEach((p,i)=>{
          const mapped = applyHomography(H, p[0], p[1]);
          drawCircle(ctx, mapped[0], mapped[1], 5);
          drawText(ctx, `G:${parts[i]}`, mapped[0]+8, mapped[1]-8);
        });
      }
    }
  }
  function drawCircle(ctx,x,y,r){ ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }
  function drawText(ctx,txt,x,y){ ctx.font = "14px sans-serif"; ctx.fillStyle = "black"; ctx.fillText(txt,x,y); ctx.fillStyle = ""; }

  // Homography math
  function computeHomography(srcPts, dstPts) {
    // srcPts and dstPts are arrays of 4 [x,y]
    // Solve Ah = b for 8 unknowns (h33 = 1)
    const A = []; const b = [];
    for (let i=0;i<4;i++){
      const [x,y] = srcPts[i];
      const [u,v] = dstPts[i];
      A.push([x, y, 1, 0,0,0, -x*u, -y*u]); b.push(u);
      A.push([0,0,0, x,y,1, -x*v, -y*v]); b.push(v);
    }
    const h8 = solveLinearSystem(A,b); // returns array length 8
    if (!h8) return null;
    const H = [h8[0],h8[1],h8[2], h8[3],h8[4],h8[5], h8[6],h8[7], 1];
    return H;
  }
  function applyHomography(H,x,y){
    const u = (H[0]*x + H[1]*y + H[2])/(H[6]*x + H[7]*y + H[8]);
    const v = (H[3]*x + H[4]*y + H[5])/(H[6]*x + H[7]*y + H[8]);
    return [u,v];
  }
  function invertHomography(H){
    // invert 3x3
    const m = [[H[0],H[1],H[2]],[H[3],H[4],H[5]],[H[6],H[7],H[8]]];
    const inv = invert3(m);
    if (!inv) return null;
    return [inv[0][0],inv[0][1],inv[0][2], inv[1][0],inv[1][1],inv[1][2], inv[2][0],inv[2][1],inv[2][2]];
  }

  function computeResults() {
    if (refCalPts.length!==4 || photoCalPts.length!==4 || refPartsPts.length!==parts.length || photoPartsPts.length!==parts.length) {
      alert("Make sure calibration and parts on both images are completed."); return;
    }
    const H = computeHomography(refCalPts, photoCalPts); // maps ref->photo
    if (!H) { alert("Failed homography"); return; }
    setHomography(H);

    // inverse to map photo points back to ref coords
    const invH = invertHomography(H);
    if (!invH) { alert("Failed invert"); return; }

    // compute pixel to cm scale using reference image width
    const refPixelWidth = refImage.width;
    const pxToCm = physicalWidthCm / refPixelWidth;

    const data = [];
    let sumScore = 0;
    for (let i=0;i<parts.length;i++){
      const photoPt = photoPartsPts[i];
      const mapped = applyHomography(invH, photoPt[0], photoPt[1]); // mapped into ref coords
      const refPt = refPartsPts[i];
      const dx = mapped[0] - refPt[0]; const dy = mapped[1] - refPt[1];
      const distPx = Math.sqrt(dx*dx + dy*dy);
      const distCm = distPx * pxToCm;
      // normalization factor: face diagonal in ref image (distance between leftmost and rightmost ref calibration corners)
      const faceDiagPx = Math.sqrt(Math.pow(refCalPts[0][0]-refCalPts[2][0],2) + Math.pow(refCalPts[0][1]-refCalPts[2][1],2));
      const norm = distPx / faceDiagPx; // fraction of face diagonal
      const score = Math.max(0, Math.round((1 - norm) * 100));
      sumScore += score;
      data.push({part: parts[i], distPx, distCm: +distCm.toFixed(2), score});
    }
    const avgScore = Math.round(sumScore / parts.length);
    setResults({data, avgScore});
  }

  // Linear solver using Gaussian elimination
  function solveLinearSystem(A, b) {
    const n = A.length; const m = A[0].length;
    // create augmented matrix
    const M = A.map((row,i)=> row.concat([b[i]]));
    // gaussian
    for (let i=0;i<m;i++){
      // find pivot row
      let maxRow = i; let maxVal = Math.abs(M[i][i]);
      for (let k=i+1;k<n;k++){ if (Math.abs(M[k][i])>maxVal){maxVal=Math.abs(M[k][i]); maxRow=k;} }
      if (Math.abs(M[maxRow][i]) < 1e-12) continue;
      // swap
      const tmp = M[i]; M[i] = M[maxRow]; M[maxRow] = tmp;
      // normalize
      const pivot = M[i][i];
      for (let j=i;j<=m;j++) M[i][j] /= pivot;
      // eliminate
      for (let r=0;r<n;r++) if (r!==i){ const factor = M[r][i]; for (let c=i;c<=m;c++) M[r][c] -= factor * M[i][c]; }
    }
    // extract solution (first m columns)
    const x = [];
    for (let i=0;i<m;i++) x.push(M[i][m]);
    return x;
  }
  function invert3(M){
    const a=M[0][0], b=M[0][1], c=M[0][2];
    const d=M[1][0], e=M[1][1], f=M[1][2];
    const g=M[2][0], h=M[2][1], i=M[2][2];
    const det = a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g);
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1/det;
    const inv = [
      [(e*i - f*h)*invDet, (c*h - b*i)*invDet, (b*f - c*e)*invDet],
      [(f*g - d*i)*invDet, (a*i - c*g)*invDet, (c*d - a*f)*invDet],
      [(d*h - e*g)*invDet, (b*g - a*h)*invDet, (a*e - b*d)*invDet]
    ];
    return inv;
  }

  // Apply inverse homography to map photo->ref
  // (we already have applyHomography which maps ref->photo given H. For mapping photo->ref we invert H and apply.)

  // UI helpers
  function resetAll(){ setRefCalPts([]); setPhotoCalPts([]); setRefPartsPts([]); setPhotoPartsPts([]); setHomography(null); setResults(null); }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Face Placement Scorer</h1>
      <p className="mb-4">Take a photo of the wall and upload the full reference image (the correct face). Follow the step-by-step workflow: calibrate, mark ground-truth keypoints, mark placements, then compute score. Optional: enter the physical width of the reference image on the wall in cm to get distances in cm.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border p-2 rounded">
          <h2 className="font-semibold">Reference Image (full face)</h2>
          <input type="file" accept="image/*" onChange={handleRefUpload} className="my-2" />
          <div className="overflow-auto">
            <canvas ref={refCanvas} onClick={onRefCanvasClick} className="border" style={{maxWidth: '100%'}} />
          </div>
          <div className="mt-2">
            <button className="mr-2 p-2 bg-gray-200 rounded" onClick={()=>setMode('calibrate-ref')}>Calibrate (click 4 corners)</button>
            <button className="mr-2 p-2 bg-gray-200 rounded" onClick={()=>setMode('mark-ref')}>Mark ground-truth parts</button>
          </div>
        </div>

        <div className="border p-2 rounded">
          <h2 className="font-semibold">Photo (wall with placed parts)</h2>
          <input type="file" accept="image/*" onChange={handlePhotoUpload} className="my-2" />
          <div className="overflow-auto">
            <canvas ref={photoCanvas} onClick={onPhotoCanvasClick} className="border" style={{maxWidth: '100%'}} />
          </div>
          <div className="mt-2">
            <button className="mr-2 p-2 bg-gray-200 rounded" onClick={()=>setMode('calibrate-photo')}>Calibrate (click 4 matching corners)</button>
            <button className="mr-2 p-2 bg-gray-200 rounded" onClick={()=>setMode('mark-photo')}>Mark participant placements</button>
          </div>
        </div>
      </div>

      <div className="mt-4 border p-3 rounded">
        <h3 className="font-semibold">Settings & Controls</h3>
        <div className="flex items-center gap-4 mt-2">
          <label>Physical width of reference on wall (cm):</label>
          <input type="number" value={physicalWidthCm} onChange={(e)=>setPhysicalWidthCm(parseFloat(e.target.value)||100)} className="border p-1 rounded w-24" />
          <button onClick={computeResults} className="ml-4 p-2 bg-blue-500 text-white rounded">Compute Score</button>
          <button onClick={resetAll} className="ml-2 p-2 bg-red-400 text-white rounded">Reset</button>
        </div>
        <p className="text-sm mt-2">Workflow: 1) Upload both images. 2) In reference, click four corners in this order: top-left, top-right, bottom-right, bottom-left. 3) In photo, click the matching four corners in the same order. 4) Click "Mark ground-truth parts" and click each named part on the reference in the order shown. 5) Click "Mark participant placements" and click each placed part on the photo in the same order. 6) Click Compute Score.</p>
      </div>

      {results && (
        <div className="mt-4 border p-3 rounded">
          <h3 className="font-semibold">Results</h3>
          <p className="mb-2">Average Score: <span className="font-bold">{results.avgScore}/100</span></p>
          <div className="overflow-auto">
            <table className="w-full text-left border-collapse">
              <thead><tr><th className="border p-1">Part</th><th className="border p-1">Distance (px)</th><th className="border p-1">Distance (cm)</th><th className="border p-1">Score</th></tr></thead>
              <tbody>
                {results.data.map((r,idx)=> (
                  <tr key={idx}><td className="border p-1">{r.part}</td><td className="border p-1">{Math.round(r.distPx)}</td><td className="border p-1">{r.distCm}</td><td className="border p-1">{r.score}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-4 text-sm text-gray-600">
        Tips: For best results, photograph the wall as straight-on as possible. The calibration step (4 corners) compensates for perspective. If you want a fully automatic solution (no clicks) we'd use feature-matching or printed AR markers — I can add that later.
      </div>
    </div>
  );
}
