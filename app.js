const $ = (selector) => document.querySelector(selector);
const photoInput = $('#photo');
const preview = $('#preview');
const previewWrap = $('#preview-wrap');
const uploadZone = $('#upload-zone');
const analyseButton = $('#analyse');
const photoStatus = $('#photo-status');
let currentFile = null;
let previewUrl = null;
let quickMetrics = null;
let ocrWorkerPromise = null;

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const scoreWord = (score) => score >= 86 ? '很好' : score >= 70 ? '基本达标' : score >= 58 ? '接近达标' : '需要练习';
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

async function imageFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function clusterPeaks(values, threshold, minGap = 3) {
  const peaks = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    if (i < values.length && values[i] >= threshold) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const end = i - 1;
      let best = start;
      for (let y = start + 1; y <= end; y++) if (values[y] > values[best]) best = y;
      if (!peaks.length || best - peaks.at(-1) >= minGap) peaks.push(best);
      start = -1;
    }
  }
  return peaks;
}

function findGridGroups(peaks) {
  const groups = [];
  for (let i = 0; i <= peaks.length - 4; i++) {
    const four = peaks.slice(i, i + 4);
    const gaps = [four[1] - four[0], four[2] - four[1], four[3] - four[2]];
    const mean = gaps.reduce((a, b) => a + b, 0) / 3;
    const variation = Math.max(...gaps.map(g => Math.abs(g - mean) / Math.max(mean, 1)));
    if (mean >= 8 && mean <= 90 && variation < .35) {
      if (!groups.some(g => Math.abs(g[0] - four[0]) < mean * 1.5)) groups.push(four);
      i += 3;
    }
  }
  return groups;
}

function analysePixels(img) {
  const canvas = $('#analysis-canvas');
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height;
  const gray = new Uint8Array(w * h);
  const rowLine = new Float32Array(h);
  let sum = 0, sumSq = 0, dark = 0, blueGray = 0;

  for (let y = 0; y < h; y++) {
    let rowHits = 0;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const v = .2126 * r + .7152 * g + .0722 * b;
      gray[y * w + x] = v;
      sum += v; sumSq += v * v;
      if (v < 115) dark++;
      const lineLike = (b > r + 5 && g >= r - 3 && v < 225) || (Math.max(r, g, b) - Math.min(r, g, b) < 18 && v > 110 && v < 210);
      if (lineLike) { rowHits++; blueGray++; }
    }
    rowLine[y] = rowHits / w;
  }

  const total = w * h;
  const mean = sum / total;
  const contrast = Math.sqrt(Math.max(0, sumSq / total - mean * mean));
  let lapSum = 0, lapSq = 0, lapN = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      lapSum += lap; lapSq += lap * lap; lapN++;
    }
  }
  const blurVariance = lapSq / lapN - Math.pow(lapSum / lapN, 2);
  const sorted = Array.from(rowLine).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length * .7)] || 0;
  const threshold = Math.max(.18, baseline + .08);
  const peaks = clusterPeaks(rowLine, threshold, Math.max(3, Math.round(h * .003)));
  const groups = findGridGroups(peaks);

  let spacingVariation = 1;
  if (groups.length) {
    const vars = groups.map(four => {
      const gaps = [four[1] - four[0], four[2] - four[1], four[3] - four[2]];
      const avg = gaps.reduce((a, b) => a + b, 0) / 3;
      return Math.max(...gaps.map(g => Math.abs(g - avg) / avg));
    });
    spacingVariation = vars.reduce((a, b) => a + b, 0) / vars.length;
  }

  const lineSlopes = [];
  const edgeSamples = 9;
  for (const group of groups.slice(0, 4)) {
    for (const targetY of group) {
      const pts = [];
      for (let s = 0; s < edgeSamples; s++) {
        const x0 = Math.round((s + .15) * w / edgeSamples);
        const x1 = Math.round((s + .85) * w / edgeSamples);
        let bestY = targetY, best = -1;
        for (let y = Math.max(0, targetY - 5); y <= Math.min(h - 1, targetY + 5); y++) {
          let hits = 0;
          for (let x = x0; x < x1; x += 3) {
            const p = (y * w + x) * 4;
            const r = data[p], g = data[p + 1], b = data[p + 2], v = gray[y * w + x];
            if ((b > r + 5 && g >= r - 3 && v < 225) || v < 175) hits++;
          }
          if (hits > best) { best = hits; bestY = y; }
        }
        pts.push([s, bestY]);
      }
      const mx = (edgeSamples - 1) / 2;
      const my = pts.reduce((a, p) => a + p[1], 0) / edgeSamples;
      let num = 0, den = 0;
      pts.forEach(([x, y]) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
      lineSlopes.push((num / Math.max(den, 1)) * edgeSamples / w);
    }
  }
  const avgSlope = lineSlopes.length ? lineSlopes.reduce((a, b) => a + b, 0) / lineSlopes.length : 0;
  const tilt = Math.abs(Math.atan(avgSlope) * 180 / Math.PI);

  const brightnessScore = clamp(100 - Math.abs(mean - 210) * 1.15);
  const sharpnessScore = clamp((Math.log10(Math.max(blurVariance, 1)) - 1.45) * 72);
  const contrastScore = clamp((contrast - 18) * 2.15);
  const inkRatio = dark / total;
  const inkScore = clamp(100 - Math.abs(inkRatio - .055) * 900);
  const gridScore = groups.length ? clamp(92 - spacingVariation * 120 - Math.max(0, tilt - 1) * 6) : null;
  // Four-line grids help with baseline analysis when present, but their absence is
  // never a fault. On blank or ordinary lined paper we use a neutral layout prior
  // and let recognition, contrast and ink consistency carry the judgement.
  const layoutScore = groups.length ? gridScore : clamp(68 + inkScore * .14 + contrastScore * .08);

  return { mean, contrast, blurVariance, brightnessScore, sharpnessScore, contrastScore, inkScore, inkRatio, groups, peaks, spacingVariation, tilt, gridScore, layoutScore, blueGrayRatio: blueGray / total };
}

async function getOcrWorker() {
  if (!window.Tesseract?.createWorker) throw new Error('ocr-library-unavailable');
  if (!ocrWorkerPromise) {
    // GitHub Pages is sometimes very slow for multi-megabyte OCR assets. Use
    // jsDelivr's mirror of this same public repository, then the known-working
    // Netlify copy if the CDN cannot load on a particular school network.
    const mirrors = [
      'https://cdn.jsdelivr.net/gh/jazmynbizzle/beautifulenglishwriting@main/vendor',
      'https://beautifulenglishwriting.netlify.app/vendor'
    ];
    ocrWorkerPromise = (async () => {
      let lastError;
      for (const mirror of mirrors) {
        try {
          const worker = await window.Tesseract.createWorker('eng', 1, {
            workerPath: new URL('./vendor/worker.min.js', document.baseURI).href,
            corePath: mirror,
            langPath: mirror,
            logger: message => {
              if (!analyseButton.classList.contains('loading')) return;
              const progress = Math.round((message.progress || 0) * 100);
              if (message.status === 'loading language traineddata') photoStatus.textContent = `首次加载英文识别模块… ${progress}%`;
              if (message.status === 'recognizing text') photoStatus.textContent = `正在辨认学生字迹… ${progress}%`;
            }
          });
          await worker.setParameters({
            tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?'- ",
            preserve_interword_spaces: '1'
          });
          return worker;
        } catch (error) {
          lastError = error;
          console.warn('OCR mirror unavailable:', mirror, error);
          photoStatus.textContent = '正在尝试备用识别线路…';
        }
      }
      throw lastError;
    })().catch(error => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function recogniseText(file) {
  try {
    const worker = await getOcrWorker();
    // Pass the File itself. An Image element's temporary blob URL may already
    // have been revoked by the time the OCR model finishes loading.
    const result = await worker.recognize(file);
    const text = (result.data.text || '').replace(/\s+/g, ' ').trim();
    const confidence = Number(result.data.confidence || 0);
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    return { available: true, text, confidence, letters, recognised: letters >= 3 && confidence >= 20 };
  } catch (error) {
    console.error('OCR failed:', error);
    if ('TextDetector' in window) {
      try {
        const bitmap = await createImageBitmap(file);
        const detector = new window.TextDetector();
        const blocks = await detector.detect(bitmap);
        bitmap.close();
        const text = blocks.map(b => b.rawValue).join(' ').replace(/\s+/g, ' ').trim();
        const letters = (text.match(/[A-Za-z]/g) || []).length;
        return { available: true, text, confidence: letters >= 2 ? 58 : 12, letters, recognised: letters >= 2 };
      } catch { /* use explicit unavailable state below */ }
    }
    return { available: false, text: '', confidence: 0, letters: 0, recognised: false };
  }
}

function photoMessage(m) {
  const problems = [];
  if (m.mean < 105) problems.push('光线偏暗');
  if (m.mean > 250) problems.push('画面过曝');
  if (m.sharpnessScore < 30) problems.push('照片可能模糊');
  if (m.groups.length && m.tilt > 4) problems.push('纸面有些倾斜');
  return problems;
}

async function handlePhoto(file) {
  if (!file || !file.type.startsWith('image/')) {
    photoStatus.textContent = '请选择 JPG、PNG 或手机照片。';
    photoStatus.className = 'photo-status warn';
    return;
  }
  if (file.size > 18 * 1024 * 1024) {
    photoStatus.textContent = '照片超过 18 MB，请降低相机分辨率后重试。';
    photoStatus.className = 'photo-status warn';
    return;
  }
  currentFile = file;
  $('#results').hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  previewWrap.hidden = false;
  uploadZone.hidden = true;
  photoStatus.textContent = '正在检查照片质量…';
  photoStatus.className = 'photo-status';
  analyseButton.disabled = true;
  const img = await imageFromFile(file);
  quickMetrics = analysePixels(img);
  const problems = photoMessage(quickMetrics);
  if (problems.length) {
    photoStatus.textContent = `可以评价，但建议留意：${problems.join('、')}。`;
    photoStatus.className = 'photo-status warn';
  } else {
    photoStatus.textContent = quickMetrics.groups.length
      ? '照片已载入。系统会参考格线，也会直接辨认字迹。'
      : '照片已载入。没有四线三格也可以直接评价。';
    photoStatus.className = 'photo-status good';
  }
  analyseButton.disabled = false;
}

photoInput.addEventListener('change', e => handlePhoto(e.target.files?.[0]));
$('#replace').addEventListener('click', () => photoInput.click());
['dragenter', 'dragover'].forEach(name => uploadZone.addEventListener(name, e => { e.preventDefault(); uploadZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(name => uploadZone.addEventListener(name, e => { e.preventDefault(); uploadZone.classList.remove('drag'); }));
uploadZone.addEventListener('drop', e => handlePhoto(e.dataTransfer.files?.[0]));

function buildScores(metrics, ocr) {
  const quality = (metrics.brightnessScore + metrics.sharpnessScore + metrics.contrastScore) / 3;
  const visualClarity = clamp(metrics.sharpnessScore * .38 + metrics.contrastScore * .30 + metrics.inkScore * .18 + metrics.brightnessScore * .14);
  const ocrClarity = ocr.available ? clamp(50 + (ocr.confidence - 30) * .65 + Math.min(ocr.letters, 14) * .8) : visualClarity;
  let clarity = ocr.available ? clamp(visualClarity * .45 + ocrClarity * .55) : visualClarity;
  if (!ocr.recognised) clarity = Math.min(clarity, 38);
  const gridAngleScore = metrics.groups.length ? 100 - Math.min(metrics.tilt, 10) * 8 : metrics.layoutScore;
  const stability = clamp(metrics.layoutScore * .48 + gridAngleScore * .16 + metrics.inkScore * .18 + clarity * .18);
  let accuracy = clamp(clarity * .58 + metrics.contrastScore * .17 + metrics.inkScore * .13 + metrics.layoutScore * .12);
  let completeness = clamp(metrics.inkScore * .32 + metrics.contrastScore * .27 + metrics.brightnessScore * .21 + metrics.sharpnessScore * .20);
  if (!ocr.recognised) {
    accuracy = Math.min(accuracy, 55);
  }
  if (quality < 48) {
    const penalty = (48 - quality) * .24;
    clarity = clamp(clarity - penalty);
    accuracy = clamp(accuracy - penalty);
    completeness = clamp(completeness - penalty);
  }
  return { clarity, accuracy, stability, completeness, quality };
}

const rubric = {
  clarity: { name: '看得清', good: '大多数字母一眼就能认出', weak: '有些字母需要停下来猜' },
  accuracy: { name: '分得开', good: '相似字母和相邻笔画容易区分', weak: '有些笔画粘在一起，字母容易看错' },
  stability: { name: '排得稳', good: '字母大小、词距和书写方向较稳定', weak: '字母大小或词距忽大忽小' },
  completeness: { name: '写得净', good: '笔画干净，页面看起来不拥挤', weak: '笔画、修改痕迹或拥挤感影响阅读' }
};

const drills = {
  clarity: ['圈出最难认的 3 个字母', '每个字母慢写 5 次，让每一笔都分开', '重写原句 1 遍，写完请同桌直接读'],
  accuracy: ['找出最容易混淆的 2 组字母，如 a/o、m/n 或 r/v', '每组对比写 5 次，让它们明显不一样', '回到原句重写一次，只检查这些字母'],
  stability: ['先定好一个小写字母的大小', '同一个词连续写 4 次，大小和倾斜保持一致', '再写 1 句，让每个词之间留出约一个字母的空隙'],
  completeness: ['圈出粘连、涂改或特别拥挤的地方', '把这些地方重新写一遍，笔画不要来回描粗', '最后抄写 1 句，写完等 3 秒再检查整洁度']
};

function priorityCopy(key) {
  if (key === 'clarity') return ['让每个字母一眼可认', '下一遍先慢一点，把粘在一起的笔画分开。写完后，如果同桌不用猜就能读出来，这一项就改对了。'];
  if (key === 'accuracy') return ['把相似字母写出区别', '重点看 a/o、m/n、r/v、u/v 等容易混淆的字母。每一对都要让别人一眼看出不同。'];
  if (key === 'stability') return ['让大小和词距保持一样', '下一遍先定好字母大小，整行不要越写越大；两个单词之间留出约一个小写字母的空隙。'];
  return ['让页面更干净', '不要来回描粗，也不要把字母挤在一起。写错时轻轻划掉一次，再清楚地重写。'];
}

const markerLikes = {
  clarity: '大多数字母能快速认出，阅卷时不需要停下来猜。',
  accuracy: '相似字母有区别，答案不容易被看成另一个词。',
  stability: '字母大小和词距比较一致，长句也容易顺着读。',
  completeness: '笔画和页面较干净，答案看起来清爽。'
};

const markerConcerns = {
  clarity: '部分字母需要猜，可能让正确答案看起来像拼写错误。',
  accuracy: '相似字母或相邻笔画容易混在一起，阅卷时可能读错。',
  stability: '大小、倾斜或词距变化较大，长句不容易快速扫读。',
  completeness: '描粗、粘连或拥挤感较明显，会影响答案的整洁度。'
};

function renderResults(scores, metrics, ocr) {
  const keys = ['clarity', 'accuracy', 'stability', 'completeness'];
  const rounded = Object.fromEntries(keys.map(k => [k, Math.round(scores[k])]));
  let overall = Math.round(rounded.clarity * .30 + rounded.accuracy * .27 + rounded.stability * .24 + rounded.completeness * .19);
  if (!ocr.recognised) overall = Math.min(overall, 59);
  const verdict = !ocr.recognised ? '字迹暂时难以辨认，先把字写清楚' : overall >= 86 ? '书写规范，继续保持' : overall >= 70 ? '基本达标，再改一处就更好' : overall >= 58 ? '接近达标，先集中改一项' : '需要再练，但方向很明确';
  $('#result-title').textContent = verdict;
  $('#overall-score').textContent = overall;
  photoStatus.textContent = ocr.available
    ? (ocr.recognised ? `识别完成：读出约 ${ocr.letters} 个英文字母。` : '识别完成：没有稳定读出英文内容。')
    : '系统没有稳定读出英文内容，本次按“字迹不够清楚”处理。';
  photoStatus.className = `photo-status ${ocr.available && ocr.recognised ? 'good' : 'warn'}`;

  $('#score-grid').innerHTML = keys.map(k => `
    <article class="score-card">
      <div class="score-card-top"><b>${rubric[k].name}</b><strong>${rounded[k]}</strong></div>
      <p>${rounded[k] >= 72 ? rubric[k].good : rubric[k].weak}</p>
      <div class="score-track"><i style="width:${rounded[k]}%"></i></div>
    </article>`).join('');

  const photoUsable = metrics.mean >= 105 && metrics.mean <= 250 && metrics.sharpnessScore >= 30;
  const writingPassed = photoUsable && ocr.recognised && ocr.confidence >= 25 && overall >= 70 && rounded.clarity >= 60;
  const passed = writingPassed;
  const panel = $('#completion-panel');
  panel.classList.toggle('passed', passed);
  $('#completion-badge').textContent = passed ? '✓ 通过' : photoUsable ? '尚未通过' : '请重拍';
  $('#completion-title').textContent = passed ? '本次书写初评通过' : photoUsable ? '请学生再练一练' : '照片不适合评价';
  const reasons = [];
  if (!photoUsable) reasons.push('照片过暗、过曝或模糊，请重拍');
  if (!ocr.recognised) reasons.push('英文内容暂时难以辨认');
  else if (ocr.confidence < 25) reasons.push('部分字母仍需猜读');
  if (overall < 70) reasons.push(`综合分还需达到 70 分（目前 ${overall} 分）`);
  if (rounded.clarity < 60) reasons.push('“看得清”还需达到 60 分');
  $('#completion-detail').textContent = passed
    ? `综合 ${overall} 分，本次练习可以结束。教师请结合学生的纸质作品确认。`
    : !photoUsable
      ? '照片过暗、过曝或模糊，请老师先重拍清楚，再判断学生字迹。'
      : reasons.slice(0, 3).join('；') + '。请学生按下方建议再练，写完后重新拍照评价。';

  const lowest = !ocr.recognised ? 'clarity' : keys.reduce((a, b) => rounded[a] <= rounded[b] ? a : b);
  const [title, text] = priorityCopy(lowest);
  $('#priority-title').textContent = title;
  $('#priority-text').textContent = text;
  $('#drill-list').innerHTML = drills[lowest].map(x => `<li>${x}</li>`).join('');

  const evidence = [];
  evidence.push({ issue: false, text: metrics.groups.length ? `照片中有四线三格，系统已把它作为书写位置的辅助参考。` : '照片中没有四线三格；本次按字迹本身评价，不影响评分。' });
  if (metrics.groups.length) evidence.push({ issue: metrics.tilt > 3.5, text: metrics.tilt <= 3.5 ? `格线倾斜约 ${metrics.tilt.toFixed(1)}°，拍摄角度基本合格。` : `格线倾斜约 ${metrics.tilt.toFixed(1)}°，建议重拍以免影响位置判断。` });
  evidence.push({ issue: metrics.sharpnessScore < 50, text: metrics.sharpnessScore >= 50 ? '笔画边缘清晰，照片可用于评价。' : '笔画边缘略模糊，本次清楚度分数仅供参考。' });
  if (ocr.available && ocr.recognised) evidence.push({ issue: false, text: `系统读出了“${escapeHtml(ocr.text.slice(0, 54))}”，字迹识别置信度约 ${Math.round(ocr.confidence)}%。` });
  else if (!photoUsable) evidence.push({ issue: true, text: '照片质量不适合判断字迹，请先重拍。' });
  else if (ocr.available) evidence.push({ issue: true, text: '系统没有稳定读出英文内容，本次暂未通过；请学生把字母写得更清楚。' });
  else evidence.push({ issue: true, text: '识别模块暂不可用，不能据此判断学生字迹。' });
  $('#evidence-list').innerHTML = evidence.map(e => `<li class="${e.issue ? 'issue' : ''}">${e.text}</li>`).join('');

  const best = keys.reduce((a, b) => rounded[a] >= rounded[b] ? a : b);
  const like = markerLikes[best];
  const concern = rounded[lowest] >= 82
    ? '整体没有明显问题。继续保持考试速度，不要为了追求花体而牺牲清晰度。'
    : markerConcerns[lowest];
  $('#marker-like').textContent = like;
  $('#marker-concern').textContent = concern;
  const comment = `阅卷老师会喜欢：${like} 阅卷老师会担心：${concern} 下一次只改这一点：${text}本次综合评价为“${scoreWord(overall)}”。`;
  $('#teacher-comment').textContent = comment;

  const problems = photoMessage(metrics);
  const qualityAlert = $('#quality-alert');
  if (problems.length) {
    qualityAlert.hidden = false;
    qualityAlert.textContent = `照片提醒：${problems.join('、')}。系统已尽量降低拍摄质量对评分的影响，但建议重拍后再比较一次。`;
  } else qualityAlert.hidden = true;

  $('#results').hidden = false;
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function runAnalysis() {
  if (!currentFile || !quickMetrics) return;
  analyseButton.disabled = true;
  analyseButton.classList.add('loading');
  analyseButton.querySelector('span:first-child').textContent = '正在分析笔迹';
  try {
    const ocr = await recogniseText(currentFile);
    if (!ocr.available) {
      photoStatus.textContent = '英文识别模块暂时无法运行，本次没有评分。请检查网络或稍后刷新重试。';
      photoStatus.className = 'photo-status warn';
      return;
    }
    const scores = buildScores(quickMetrics, ocr);
    renderResults(scores, quickMetrics, ocr);
  } catch {
    photoStatus.textContent = '分析没有完成，请换一张更清晰的照片再试。';
    photoStatus.className = 'photo-status warn';
  } finally {
    analyseButton.disabled = false;
    analyseButton.classList.remove('loading');
    analyseButton.querySelector('span:first-child').textContent = '开始智能评价';
  }
}
window.runAnalysis = runAnalysis;
analyseButton.onclick = runAnalysis;

$('#copy-comment').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('#teacher-comment').textContent);
    e.currentTarget.textContent = '已复制';
    setTimeout(() => e.currentTarget.textContent = '复制评语', 1500);
  } catch { e.currentTarget.textContent = '请长按评语复制'; }
});

function reset() {
  currentFile = null; quickMetrics = null;
  photoInput.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.src = '';
  previewWrap.hidden = true;
  uploadZone.hidden = false;
  photoStatus.textContent = '';
  photoStatus.className = 'photo-status';
  analyseButton.disabled = true;
  $('#results').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#retry').addEventListener('click', reset);

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register(new URL('./sw.js', document.baseURI).href).catch(() => {}));
