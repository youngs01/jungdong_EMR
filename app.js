// ══════════════════════════════════════════════════════════
// JUNGDONG EMR v2.2 — 핵심 데이터 스토어 & 엔진
// ══════════════════════════════════════════════════════════

// ─── API 레이어 (각 부서간 연동 시뮬레이션) ──────────────
const API = {
  baseURL: 'https://192.168.1.10:8443/api/v1',  // 실제 배포 시 서버 URL
  dbURL:   'mysql://192.168.1.11:3306/jungdong_emr',
  pacsURL: 'https://192.168.1.20:4242/pacs',
  ediURL:  'https://edi.hira.or.kr/edi',

  // API 엔드포인트 정의 (실제 구현 시 fetch 사용)
  endpoints: {
    // 환자
    patients:      '/patients',
    patientById:   '/patients/:id',
    visitHistory:  '/patients/:id/visits',
    visitType:     '/patients/:id/visit-type',   // 신환/초진/재진 판별

    // 부서별
    reception:     '/reception/queue',
    outpatient:    '/outpatient/:dept/queue',
    emr:           '/emr/chart/:visitId',
    pharmacy:      '/pharmacy/orders',
    radiology:     '/radiology/worklist',
    lab:           '/lab/results',
    ward:          '/ward/patients',
    or:            '/or/schedule',
    payment:       '/payment/bills',

    // 관리
    users:         '/admin/users',
    roles:         '/admin/roles',
    logs:          '/admin/audit-logs',

    // 심평원
    claim:         '/hira/claim',
    dur:           '/hira/dur-check',
    claimCheck:    '/hira/pre-check',
    dashboard:     '/stats/dashboard',

    // 예약
    reservations:      '/reservations',
    reservationById:   '/reservations/:id',
  },

  // API 호출 래퍼 (실제 fetch → 여기선 로컬 DB로 라우팅)
  async call(method, endpoint, data) {
    // 실제 배포 환경:
    // return fetch(this.baseURL + endpoint, {
    //   method, headers: {'Content-Type':'application/json', 'Authorization':'Bearer '+SESSION.token},
    //   body: data ? JSON.stringify(data) : undefined
    // }).then(r => r.json());

    // 데모: 로컬 처리
    // 도메인에 따라 간단한 서비스 제공
    if (endpoint === this.endpoints.reservations && method === 'GET') {
      var date = data && data.date;
      var rooms = (DB.reservations||[]).filter(function(r){
        if(date && r.date) return r.date === date;
        return true;
      });
      return new Promise(resolve => {
        setTimeout(() => resolve({ success: true, data: rooms, timestamp: new Date().toISOString() }), 50);
      });
    }

    if (endpoint === this.endpoints.reservations && method === 'POST') {
      if(!DB.reservations) DB.reservations = [];
      DB.reservations.push(data);
      return new Promise(resolve => {
        setTimeout(() => resolve({ success: true, data: data, timestamp: new Date().toISOString() }), 50);
      });
    }

    if (endpoint === this.endpoints.reservations && method === 'DELETE') {
      var rid = data && data.id;
      if(rid && DB.reservations) {
        DB.reservations = DB.reservations.map(function(r){
          if(r.id===rid) { r.status='취소'; }
          return r;
        });
      }
      return new Promise(resolve => {
        setTimeout(() => resolve({ success: true, data: null, timestamp: new Date().toISOString() }), 50);
      });
    }

    if (endpoint === this.endpoints.dashboard) {
      var labCritical = (DB.labResults||[]).filter(l => l.status==='critical' || l.flag==='abnormal').length;
      var pharmacyWait = (DB.prescriptions||[]).filter(p => p.status==='waiting' || p.status==='dur_check').length;
      var alertList = (DB.notifications||[]).filter(n => !n.read && ['lab_critical','dur_warning','vital_alert','stock_low','pharmacy_ready'].includes(n.type));
      var alertExamples = alertList.slice(0,2).map(n => n.message || n.text || '알림');
      return new Promise(resolve => {
        setTimeout(() => resolve({
          success: true,
          data: {
            abnormalLab: labCritical,
            pharmacyWait: pharmacyWait,
            anomalyAlerts: alertList.length,
            anomalyExamples: alertExamples,
          },
          timestamp: new Date().toISOString()
        }), 50);
      });
    }

    return new Promise(resolve => {
      setTimeout(() => resolve({ success: true, data, timestamp: new Date().toISOString() }), 50);
    });
  },

  get:    (ep, params) => API.call('GET', ep, params),
  post:   (ep, data)   => API.call('POST', ep, data),
  put:    (ep, data)   => API.call('PUT', ep, data),
  delete: (ep)         => API.call('DELETE', ep),
};

// 앱 전역 설정
window.LOGO_URL = window.LOGO_URL || 'logo.svg';

function setLogoUrl(url) {
  if (!url) return;
  window.LOGO_URL = url;
  var loginLogo = document.getElementById('logo-img-login');
  if (loginLogo) loginLogo.src = url;
  var sidebarLogo = document.getElementById('logo-img-sidebar');
  if (sidebarLogo) sidebarLogo.src = url;
}

function applyLogoUrl() {
  setLogoUrl(window.LOGO_URL);
}

// ─── 부서간 API 이벤트 버스 ──────────────────────────────
const EventBus = {
  listeners: {},
  on(event, fn)  { (this.listeners[event] = this.listeners[event]||[]).push(fn); },
  emit(event, data) { (this.listeners[event]||[]).forEach(fn => fn(data)); },
  // 이벤트 목록: reception.new, emr.saved, pharmacy.order, radiology.request, lab.result, ward.admit, payment.complete
};

// ─── 세션 관리 ───────────────────────────────────────────
const SESSION = {
  user: null,
  token: null,
  loginTime: null,
  isLoggedIn: () => !!SESSION.user,
  hasPermission: (perm) => {
    if(!SESSION.user) return false;
    const role = SESSION.user.role;
    const perms = ROLE_PERMISSIONS[role] || [];
    return perms.includes('*') || perms.includes(perm);
  }
};

// ─── 권한 시스템 ─────────────────────────────────────────
const ROLE_PERMISSIONS = {
  // 최고권한 (동등)
  'hospital_director': ['*'],     // 병원장
  'admin':             ['*'],     // 관리자 (병원장과 동일)

  // 진료과 의사 (= 원장급)
  'doctor_ortho1':  ['emr.*','patients.*','reception.read','radiology.read','lab.read','ward.read','pharmacy.read','stats.read','reservation.*'],
  'doctor_ortho2':  ['emr.*','patients.*','reception.read','radiology.read','lab.read','ward.read','pharmacy.read','stats.read','reservation.*'],
  'doctor_neuro':   ['emr.*','patients.*','reception.read','radiology.read','lab.read','ward.read','or.*','pharmacy.read','stats.read','reservation.*'],
  'doctor_internal':['emr.*','patients.*','reception.read','radiology.read','lab.read','ward.read','pharmacy.read','stats.read','reservation.*'],
  'doctor_anesthesia': ['emr.*','patients.*','or.*','ward.read','pharmacy.read','radiology.read','stats.read','reservation.*'],
  'doctor_radiology':['radiology.*','emr.read','patients.read'],

  // 간호사
  'nurse':     ['ward.*','nursing.*','vitals.*','mar.*','patients.read','emr.read','lab.read','pharmacy.read'],

  // 원무
  'reception': ['reception.*','patients.*','payment.*','reservation.*','consent.*'],

  // 약사
  'pharmacist':['pharmacy.*','inventory.*','dur.*','patients.read'],

  // 물리치료사
  'pt_therapist': ['pt.*','patients.read','emr.read'],

  // 방사선사
  'radiographer': ['radiology.*','patients.read'],
  'finance_staff': ['finance.*','payment.*','stats.read','inventory.read'],
  'claim_staff':   ['claim.*','emr.read','patients.read','stats.read','radiology.read','lab.read'],

  // 기타 의료진
  'nonsurg_doctor': ['emr.*','patients.*','nonsurg.*','radiology.read','lab.read','inventory.read'],
};

// ─── 사용자 계정 DB ──────────────────────────────────────
const DB = {
  currentUser: null,
  currentDept: 'reception',

  // ── 사용자 계정 (관리자가 생성/관리) ──
  users: [
    {
      id:'USR-001', username:'admin', password:'Admin1234!',
      name:'시스템관리자', role:'admin', dept:'admin',
      email:'admin@jungdong.kr', phone:'010-0000-0001',
      license:'', joinDate:'2015-01-01', status:'active',
      permissions:['*'], lastLogin:'', createdBy:'system',
      spec:'시스템 관리자'
    },
  ],

  // ── 환자 마스터 DB ──────────────────────────────────────
  patientMaster: [],

  // ── 오늘 접수 목록 (실시간) ───────────────────────────
  patients: [],

  wardPatients: [],
  inventory: [], // 나중에 EMR DB에서 연동 예정
  reservations: [],
  radiologyImages: [],
  claimData: {
    month:'2025-01', totalCases:342, totalAmt:18650000, submitted:true,
    deletions:[
      // 삭감 내역은 DB.claimData.deletions 에서 관리
    ]
  },
  auditLog: [],
  surgeries: [],         // 수술 스케줄 + 수술 기록
  prescriptions: [],     // 처방 DB (EMR 저장 시 자동 연동)
  consents: [],          // 전자동의서
  ptSchedules: [],       // 물리치료/비수술 스케줄
  labResults: [],        // 검사 결과
  notifications: [],     // 실시간 알림
  payments: [],          // 수납 내역 {id,ptName,ptId,amount,method,status,issuedAt,paidAt,items:[]}
  stockMovements: [],    // 재고 입출고 이력 {id,code,name,type:'in'|'out'|'use',qty,reason,surgId,createdAt,createdBy}
  orders: [],            // 발주 내역 {id,code,name,qty,unit,price,status:'pending'|'ordered'|'received',orderedAt,receivedAt}
  anesthesiaRecords: [], // 마취 기록 {surgId,type,drugs:[],vitals:[{time,bp,hr,spo2}],events:[],anesthesiologist,startTime,endTime}

  // ── 진료 차트 DB ─────────────────────────────────────
  // status: 'draft'(임시저장) | 'locked'(최종저장·불변) | 'amended'(수정본)
  emrCharts: [],
};

// ── patients는 VisitTypeEngine 선언 후 initPatients()로 초기화 ──

// ══════════════════════════════════════════════════════════
// 신환 / 초진 / 재진 자동 판별 엔진 (심평원 기준)
// ══════════════════════════════════════════════════════════
const VisitTypeEngine = {

  /**
   * 방문 유형 판별 (심평원 요양급여비용 청구 기준)
   *
   * [신환] : 해당 의료기관에 처음 내원한 환자
   * [초진] : 동일 의료기관에서 동일 환자가 다른 상병(질환)으로 처음 진료받는 경우
   *          또는 동일 상병이라도 치료 종결 후 새로운 발병 (치료 종결 후 30일 초과 또는 완전 회복 후 재발)
   * [재진] : 동일 의료기관 동일 의사에게 동일 상병으로 계속 진료받는 경우
   *
   * @param {string} pid - 환자 등록번호
   * @param {string} targetDept - 오늘 진료받을 진료과
   * @param {string} targetIcd - 오늘 상병코드 (접수 시점에는 null)
   * @returns {object} { type, reason, detail, claimCode }
   */
  determineType(pid, targetDept, targetIcd) {
    const master = DB.patientMaster.find(p => p.pid === pid);
    if(!master) return { type:'신환', reason:'미등록 환자', detail:'해당 의료기관 첫 내원', claimCode:'AA100' };

    const history = master.visitHistory;

    // ─ 케이스 1: 병원 첫 방문 (방문이력 전무) ─────────
    if(history.length === 0) {
      return {
        type: '신환',
        reason: '해당 의료기관 최초 내원',
        detail: '환자 마스터 DB 등록 후 최초 방문',
        claimCode: 'AA100',   // 초진 진찰료 코드
        badge: 'badge-new',
        color: '#2e7d32',
      };
    }

    // 방문이력 있음 → 이제부터 초진/재진 판별
    const today = new Date();

    // ─ 케이스 2: 특정 진료과 + 상병 기준으로 분류 ──────
    if(targetDept && targetIcd) {
      return this._classifyWithIcd(history, targetDept, targetIcd, today);
    }

    // ─ 케이스 3: 접수 시 (상병 미정) → 진료과 기준 예비 판별 ─
    if(targetDept) {
      return this._classifyByDept(history, targetDept, today);
    }

    // ─ 케이스 4: 진료과도 미정 → 일반 재진 여부만 판별 ─
    const lastVisit = history[history.length - 1];
    const daysSinceLast = this._daysBetween(new Date(lastVisit.date), today);
    if(daysSinceLast <= 365) {
      return { type:'재진', reason:'최근 1년 내 내원 이력', detail:`마지막 방문: ${lastVisit.date} (${daysSinceLast}일 전)`, claimCode:'AA200', badge:'badge-revisit', color:'#6a1b9a' };
    }
    return { type:'초진', reason:'1년 이상 미내원 후 재방문', detail:`마지막 방문: ${lastVisit.date} (${daysSinceLast}일 전)`, claimCode:'AA100', badge:'badge-first', color:'#1565c0' };
  },

  _classifyWithIcd(history, dept, icd, today) {
    // 동일 진료과 + 동일 상병 이력 확인
    const sameHistory = history.filter(v => v.dept === dept && v.icd10 === icd);

    if(sameHistory.length === 0) {
      // 이 진료과에서 이 상병으로 진료받은 적 없음 → 초진
      const anyDeptHistory = history.filter(v => v.dept === dept);
      return {
        type: '초진',
        reason: anyDeptHistory.length > 0
          ? '동일 진료과 내 새로운 상병으로 첫 진료 (심평원 기준: 초진)'
          : '해당 진료과 첫 방문',
        detail: `상병코드 ${icd} 첫 진료. 진찰료 초진 산정.`,
        claimCode: 'AA100',
        hiraNote: '동일 기관이라도 새로운 상병 → 초진 진찰료 청구 가능 (요양급여비용 제1편 제2부 제1장)',
        badge: 'badge-first',
        color: '#1565c0',
      };
    }

    // 동일 상병 이력 있음 → 마지막 진료일 기준 판단
    const lastSame = sameHistory[sameHistory.length - 1];
    const daysSince = this._daysBetween(new Date(lastSame.date), today);

    // 심평원 기준: 30일 이내 동일 상병 재방문 → 재진
    if(daysSince <= 30) {
      return {
        type: '재진',
        reason: `동일 상병 ${daysSince}일 전 방문 (30일 이내)`,
        detail: `마지막 동일 상병 방문: ${lastSame.date}. 재진 진찰료 산정.`,
        claimCode: 'AA200',
        hiraNote: '동일 상병 계속 치료 (30일 이내) → 재진 (요양급여비용 제1편 제2부)',
        badge: 'badge-revisit',
        color: '#6a1b9a',
      };
    }

    // 30일 초과 but 365일 이내 → 급여기준 확인 필요
    if(daysSince <= 365) {
      // 만성질환 여부 확인 (당뇨, 고혈압, 퇴행성 등)
      const isChronicDisease = this._isChronicIcd(icd);
      if(isChronicDisease) {
        return {
          type: '재진',
          reason: `만성질환 (${icd}) ${daysSince}일 만에 재방문`,
          detail: `만성질환은 치료 종결 개념 없이 계속 관리 → 재진. 마지막 방문: ${lastSame.date}`,
          claimCode: 'AA200',
          hiraNote: '만성질환 (당뇨, 고혈압, 퇴행성 관절염 등) → 치료 종결 없이 재진 산정 가능',
          badge: 'badge-revisit',
          color: '#6a1b9a',
        };
      }
      return {
        type: '초진',
        reason: `동일 상병 30일 초과 ${daysSince}일 만에 재방문 (급성 질환 치료 종결 후 재발 가능성)`,
        detail: `마지막 방문: ${lastSame.date}. 치료 종결 후 재발로 초진 산정 권장.`,
        claimCode: 'AA100',
        hiraNote: '급성 질환 치료 종결 후 30일 초과 → 초진 산정 권장 (심평원 심사지침)',
        badge: 'badge-first',
        color: '#1565c0',
        warning: '⚠ 30일 초과 재방문: 초진/재진 기준 확인 필요. 차트에 치료 지속 여부 기재 권고.',
      };
    }

    // 1년 초과 → 초진
    return {
      type: '초진',
      reason: `1년 이상 경과 후 재방문 (${Math.floor(daysSince/30)}개월)`,
      detail: `마지막 방문: ${lastSame.date}. 치료 종결 후 충분한 기간 경과 → 초진 산정.`,
      claimCode: 'AA100',
      hiraNote: '1년 이상 미내원 후 동일 상병 재방문 → 초진 산정 가능',
      badge: 'badge-first',
      color: '#1565c0',
    };
  },

  _classifyByDept(history, dept, today) {
    const deptHistory = history.filter(v => v.dept === dept);
    if(deptHistory.length === 0) {
      const anyHistory = history.length > 0;
      return {
        type: anyHistory ? '초진' : '신환',
        reason: anyHistory ? `${this._deptLabel(dept)} 첫 방문 (타 진료과 이력 있음)` : '해당 의료기관 첫 방문',
        detail: anyHistory ? `동일 환자가 ${this._deptLabel(dept)}에 처음 내원. 상병 확인 후 초진/재진 최종 결정.` : '신환 등록 필요',
        claimCode: 'AA100',
        badge: anyHistory ? 'badge-first' : 'badge-new',
        color: anyHistory ? '#1565c0' : '#2e7d32',
        pendingConfirm: true,  // 진료 후 상병 확정 시 최종 결정
      };
    }
    const lastDept = deptHistory[deptHistory.length - 1];
    const daysSince = this._daysBetween(new Date(lastDept.date), today);
    return {
      type: daysSince <= 30 ? '재진' : '초진',
      reason: `${this._deptLabel(dept)} 마지막 방문 ${daysSince}일 전`,
      detail: `상병 확정 후 최종 초진/재진 결정. 현재 예비 판별: ${daysSince <= 30 ? '재진' : '초진'}.`,
      claimCode: daysSince <= 30 ? 'AA200' : 'AA100',
      badge: daysSince <= 30 ? 'badge-revisit' : 'badge-first',
      color: daysSince <= 30 ? '#6a1b9a' : '#1565c0',
      pendingConfirm: true,
    };
  },

  _isChronicIcd(icd) {
    const chronicPrefixes = [
      'E10','E11','E12','E13','E14',  // 당뇨
      'I10','I11','I12','I13',        // 고혈압
      'M17','M16','M15','M47','M51',  // 퇴행성 관절/척추
      'J44','J45',                    // COPD, 천식
      'N18',                          // 만성 신장질환
      'I25',                          // 만성 허혈성 심장질환
      'F32','F33',                    // 우울증
      'K74',                          // 간경화
    ];
    return chronicPrefixes.some(p => icd.startsWith(p));
  },

  _daysBetween(d1, d2) {
    return Math.floor(Math.abs(d2 - d1) / (1000*60*60*24));
  },

  _deptLabel(dept) {
    return {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',health:'건강검진',pt:'물리치료',nonsurg:'비수술',radiology:'영상의학'}[dept] || dept;
  },

  // 접수 화면용: 환자 정보 입력 실시간 판별
  analyzeForReception(pid, dept, rrn) {
    if(!pid && rrn) {
      const found = DB.patientMaster.find(p => p.rrn.replace(/-/g,'').startsWith(rrn.replace(/-/g,'').substring(0,6)));
      if(found) return this.determineType(found.pid, dept, null);
    }
    if(pid) return this.determineType(pid, dept, null);
    return { type:'신환', reason:'신규 환자', detail:'주민번호/등록번호 확인 결과 신규 등록 필요', claimCode:'AA100', badge:'badge-new', color:'#2e7d32' };
  }
};

// ── VisitTypeEngine 선언 후 patients 초기화 ─────────────────
function initPatients() {
  const depts   = ['ortho1','ortho1','neuro','internal','ortho2','neuro','pt','health'];
  const doctors = ['김창우 원장','김창우 원장','김영우 원장','정원석 원장','여용범 원장','김영우 원장','-','-'];
  const statuses = ['대기','진료중','대기','완료','대기','대기','치료중','검진중'];
  const ccs = ['무릎 통증','요통','두통, 어지럼증','당뇨 관리','어깨 통증','목 통증 방사통','물리치료','건강검진'];
  const times = ['09:12','09:25','09:30','09:15','09:40','09:45','09:50','09:55'];

  DB.patients = DB.patientMaster.map((pm, i) => {
    const vt = VisitTypeEngine.determineType(pm.pid, depts[i] || 'ortho1', null);
    return {
      id: pm.pid, name: pm.name, dob: pm.dob, gender: pm.gender,
      phone: pm.phone, insurance: pm.insurance,
      dept: depts[i] || 'ortho1',
      doctor: doctors[i] || '-',
      type: vt.type,
      visitResult: vt,
      status: statuses[i] || '대기',
      cc: ccs[i] || '-',
      registered: times[i] || '00:00'
    };
  });
}
initPatients();


const DEPTS = {
  reception:        { label:'원무접수',    color:'#1a4fa0', role:'원무팀',    avatar:'원' },
  ortho1:           { label:'정형외과1',   color:'#1a4fa0', role:'정형외과1', avatar:'정' },
  ortho2:           { label:'정형외과2',   color:'#1565c0', role:'정형외과2', avatar:'정' },
  neuro:            { label:'신경외과',    color:'#4527a0', role:'신경외과',  avatar:'신' },
  internal:         { label:'내과',        color:'#00695c', role:'내과',      avatar:'내' },
  anesthesia:       { label:'마취통증의학과', color:'#6d4c41', role:'마취통증',  avatar:'마' },
  health:           { label:'건강검진센터', color:'#558b2f', role:'검진센터',  avatar:'검' },
  pt:               { label:'물리치료센터', color:'#e65100', role:'물리치료사',avatar:'물' },
  nonsurg:          { label:'비수술치료센터',color:'#6a1b9a',role:'시술팀',   avatar:'비' },
  or:               { label:'수술실',      color:'#b71c1c', role:'수술실',    avatar:'수' },
  ward:             { label:'입원병실',    color:'#0277bd', role:'간호사',    avatar:'간' },
  pharmacy:         { label:'약제실',      color:'#2e7d32', role:'약사',      avatar:'약' },
  radiology:        { label:'영상의학과',  color:'#37474f', role:'영상의학',  avatar:'영' },
  finance:          { label:'재무과',      color:'#1b5e20', role:'재무팀',    avatar:'재' },
  claim_mgmt:       { label:'심사청구과',  color:'#4a148c', role:'심사청구팀',avatar:'청' },
  admin:            { label:'관리자',      color:'#455a64', role:'관리자',    avatar:'관' },
  hospital_director:{ label:'병원장',      color:'#b71c1c', role:'병원장',    avatar:'원' },
};

const MENUS = {
  reception: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'📝', label:'오늘 접수', screen:'reception' },
    { icon:'👥', label:'환자 관리', screen:'patients' },
    { icon:'📅', label:'예약 관리', screen:'reservation' },
    { icon:'💰', label:'수납/청구', screen:'payment' },
    { icon:'📜', label:'동의서', screen:'consent' },
  ],
  ortho1: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'📝', label:'오늘 접수', screen:'reception' },
    { icon:'🏥', label:'외래 환자', screen:'outpatient' },
    { icon:'📋', label:'진료 기록', screen:'emr' },
    { icon:'📅', label:'예약 현황', screen:'reservation' },
    { icon:'🛏', label:'입원 환자', screen:'ward' },
    { icon:'🔪', label:'수술실', screen:'or' },
    { icon:'🍽', label:'식단/조리실', screen:'meal' },
  ],
  ortho2: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'📝', label:'오늘 접수', screen:'reception' },
    { icon:'🏥', label:'외래 환자', screen:'outpatient' },
    { icon:'📋', label:'진료 기록', screen:'emr' },
    { icon:'📅', label:'예약 현황', screen:'reservation' },
    { icon:'🛏', label:'입원 환자', screen:'ward' },
    { icon:'🔪', label:'수술실', screen:'or' },
  ],
  neuro: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'📝', label:'오늘 접수', screen:'reception' },
    { icon:'🏥', label:'외래 환자', screen:'outpatient' },
    { icon:'📋', label:'진료 기록', screen:'emr' },
    { icon:'🔪', label:'수술실', screen:'or' },
    { icon:'🛏', label:'입원 환자', screen:'ward' },
  ],
  internal: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'📝', label:'오늘 접수', screen:'reception' },
    { icon:'🏥', label:'외래 환자', screen:'outpatient' },
    { icon:'📋', label:'진료 기록', screen:'emr' },
    { icon:'📅', label:'예약 현황', screen:'reservation' },
    { icon:'🔬', label:'검진 현황', screen:'health' },
  ],
  anesthesia: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'🏥', label:'마취 외래', screen:'outpatient' },
    { icon:'🔪', label:'수술 마취', screen:'or' },
    { icon:'💉', label:'통증 클리닉', screen:'nonsurg' },
    { icon:'📋', label:'EMR 기록', screen:'emr' },
    { icon:'🛏', label:'병동 환자', screen:'ward' },
  ],
  health: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'📝', label:'오늘 접수', screen:'reception' },
    { icon:'🔬', label:'검진 현황', screen:'health' },
    { icon:'📊', label:'검진 결과', screen:'emr' },
    { icon:'📅', label:'예약 현황', screen:'reservation' },
  ],
  pt: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'🏃', label:'치료 현황', screen:'pt' },
    { icon:'📊', label:'치료 기록', screen:'emr' },
    { icon:'📅', label:'예약 현황', screen:'reservation' },
  ],
  nonsurg: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'💉', label:'시술 현황', screen:'nonsurg' },
    { icon:'📋', label:'시술 기록', screen:'emr' },
    { icon:'📦', label:'재고 관리', screen:'inventory' },
  ],
  or: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'🔪', label:'수술 현황', screen:'or' },
    { icon:'📦', label:'수술재료대', screen:'inventory' },
    { icon:'📋', label:'수술 기록', screen:'emr' },
    { icon:'✅', label:'안전 체크리스트', screen:'or' },
    { icon:'📜', label:'수술 동의서', screen:'consent' },
  ],
  ward: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'🛏', label:'병동 현황', screen:'ward' },
    { icon:'🍽', label:'식단/조리실', screen:'meal' },
    { icon:'📋', label:'간호기록', screen:'nursing' },
    { icon:'💊', label:'투약 관리', screen:'pharmacy' },
    { icon:'🔬', label:'검사 결과', screen:'lab' },
  ],
  pharmacy: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'💊', label:'조제 대기', screen:'pharmacy' },
    { icon:'📦', label:'재고 관리', screen:'inventory' },
    { icon:'📊', label:'조제 현황', screen:'stats' },
  ],
  radiology: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'🩻', label:'영상 판독실', screen:'radiology' },
    { icon:'📤', label:'영상 업로드', screen:'radiology' },
    { icon:'📋', label:'판독 기록', screen:'radiology' },
    { icon:'📊', label:'판독 통계', screen:'stats' },
  ],
  finance: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'💵', label:'재무 현황', screen:'finance' },
    { icon:'📊', label:'수입/지출', screen:'finance' },
    { icon:'🧾', label:'세금계산서', screen:'finance' },
    { icon:'📈', label:'재무 통계', screen:'stats' },
  ],
  claim_mgmt: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'💰', label:'청구 관리', screen:'claim_mgmt' },
    { icon:'🔍', label:'심사 현황', screen:'claim_mgmt' },
    { icon:'⚠', label:'삭감/불능', screen:'claim_mgmt' },
    { icon:'📤', label:'EDI 전송', screen:'claim_mgmt' },
    { icon:'📋', label:'이의신청', screen:'claim_mgmt' },
    { icon:'📊', label:'청구 통계', screen:'stats' },
  ],
  admin: [
    { icon:'🏠', label:'대시보드', screen:'dashboard' },
    { icon:'📝', label:'오늘 접수', screen:'reception' },
    { icon:'👥', label:'환자 관리', screen:'patients' },
    { icon:'🏥', label:'외래 현황', screen:'outpatient' },
    { icon:'�', label:'수납/청구', screen:'payment' },
    { icon:'🛏', label:'병동 현황', screen:'ward' },
    { icon:'🔪', label:'수술실', screen:'or' },
    { icon:'📅', label:'예약 관리', screen:'reservation' },
    { icon:'🩻', label:'영상의학', screen:'radiology' },
    { icon:'🏥', label:'심사청구', screen:'claim_mgmt' },
    { icon:'🍽', label:'식단/조리실', screen:'meal' },
    { icon:'💊', label:'약제실', screen:'pharmacy' },
    { icon:'📦', label:'재고 관리', screen:'inventory' },
    { icon:'💵', label:'재무 관리', screen:'finance' },
    { icon:'📊', label:'통계', screen:'stats' },
    { icon:'👨‍⚕️', label:'직원 관리', screen:'staff' },
    { icon:'🔑', label:'계정 관리', screen:'users' },
    { icon:'⚙', label:'시스템 설정', screen:'settings' },
  ],
};

// ─── LOGIN ───────────────────────────────────────────────
let selectedDept = 'reception';
function selectDept(el, dept) {
  document.querySelectorAll('.dept-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  selectedDept = dept;
}

function doLogin() {
  const username = document.getElementById('login-id').value.trim();
  const password = document.getElementById('login-pw').value;
  const user = DB.users.find(u => u.username === username && u.password === password && u.status === 'active');

  if(!user) {
    document.getElementById('login-error').textContent = '아이디 또는 비밀번호가 올바르지 않습니다.';
    document.getElementById('login-error').style.display = 'block';
    // 감사 로그
    DB.auditLog.push({ time: new Date().toISOString(), action: 'LOGIN_FAIL', user: username, ip: '192.168.1.xxx' });
    return;
  }

  // 로그인 성공
  SESSION.user = user;
  SESSION.loginTime = new Date();
  SESSION.token = 'JWT_' + btoa(user.id + ':' + Date.now());
  DB.currentUser = user;
  DB.auditLog.push({ time: new Date().toISOString(), action: 'LOGIN_SUCCESS', user: user.username, name: user.name, ip: '192.168.1.xxx' });
  user.lastLogin = new Date().toLocaleString('ko-KR');

  // 부서 매핑
  const deptMap = {
    'admin':              'admin',
    'hospital_director':  'ortho1',
    'doctor_ortho1':      'ortho1',
    'doctor_ortho2':      'ortho2',
    'doctor_neuro':       'neuro',
    'doctor_internal':    'internal',
    'doctor_anesthesia':  'anesthesia',
    'doctor_radiology':   'radiology',
    'nurse':              'ward',
    'reception':          'reception',
    'pharmacist':         'pharmacy',
    'pt_therapist':       'pt',
    'radiographer':       'radiology',
    'nonsurg_doctor':     'nonsurg',
    'finance_staff':      'finance',
    'claim_staff':        'claim_mgmt',
  };
  const dept = deptMap[user.role] || 'reception';
  DB.currentDept = dept;

  const deptInfo = DEPTS[dept] || DEPTS['reception'];
  const isDirector = user.role === 'hospital_director';

  // 사이드바
  document.getElementById('sidebar-dept-label').textContent = isDirector ? '병원장 · 정형외과1' : deptInfo.label;
  document.getElementById('user-avatar-initials').textContent = user.name[0];
  document.getElementById('user-name-display').textContent = isDirector ? user.name + ' 원장' : user.name;
  document.getElementById('user-role-display').textContent = {
    admin:'시스템 관리자', hospital_director:'병원장 / 정형외과1 원장',
    doctor_ortho1:'정형외과1 의사', doctor_ortho2:'정형외과2 의사',
    doctor_neuro:'신경외과 원장', doctor_internal:'내과·건강검진 원장',
    doctor_radiology:'진단영상의학과 원장', doctor_anesthesia:'마취통증의학과 원장', nurse:'간호사',
    reception:'원무 접수', pharmacist:'약사',
    pt_therapist:'물리치료사', radiographer:'방사선사',
    finance_staff:'재무 담당', claim_staff:'심사청구 담당',
  }[user.role] || user.role;

  // 상단바 (병원장은 정형외과1 색상)
  document.getElementById('topbar-dept').textContent = isDirector ? '병원장 ' + user.name + ' 원장' : user.role === 'finance_staff' ? '재무과' : user.role === 'claim_staff' ? '심사청구과' : deptInfo.label;
  document.getElementById('topbar-dept').style.background = isDirector ? DEPTS['ortho1'].color : deptInfo.color;

  buildNav(dept, user.role);
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderScreen('dashboard');
  const roleLabel = user.role === 'hospital_director' ? '병원장 / 정형외과1 원장' : deptInfo.role;
  notify('로그인 성공', `${user.name}님 (${roleLabel}), 환영합니다!`, 'success');
  
  // 식단 자동 업데이트 초기화
  initMealAutoUpdate();
}

// ─── NAV ────────────────────────────────────────────────
function buildNav(dept, role) {
  let menus;
  if (role === 'hospital_director') {
    // 병원장 = 정형외과1 진료 메뉴 + 병원 전체 관리 메뉴 통합
    const doctorMenus = (MENUS['ortho1'] || []).map(m => m);
    const adminOnlyMenus = [
      { icon:'🏥', label:'심사청구', screen:'claim_mgmt' },
      { icon:'💵', label:'재무 관리', screen:'finance' },
      { icon:'📊', label:'통계', screen:'stats' },
      { icon:'📦', label:'재고 관리', screen:'inventory' },
      { icon:'🔪', label:'수술실', screen:'or' },
      { icon:'👨‍⚕️', label:'직원 관리', screen:'staff' },
      { icon:'🔑', label:'계정 관리', screen:'users' },
      { icon:'⚙', label:'시스템 설정', screen:'settings' },
    ];
    // 진료 메뉴 + 구분선 역할 + 관리 메뉴
    menus = doctorMenus.concat([{ icon:'─', label:'── 병원 관리 ──', screen:'dashboard', divider:true }]).concat(adminOnlyMenus);
  } else if (role === 'admin') {
    menus = MENUS['admin'] || [];
  } else {
    menus = MENUS[dept] || MENUS['reception'];
  }

  const nav = document.getElementById('nav-menu');
  nav.innerHTML = '<div class="nav-label">메뉴</div>' + menus.map(m => {
    if (m.divider) {
      return `<div style="padding:8px 16px 4px;font-size:9px;font-weight:700;letter-spacing:1px;color:rgba(168,188,216,0.5);text-transform:uppercase;user-select:none">${m.label}</div>`;
    }
    return `<div class="nav-item${m.screen==='dashboard'?' active':''}" onclick="renderScreen('${m.screen}',this)">
      <span class="icon">${m.icon}</span>${m.label}
      ${m.badge ? `<span class="nav-badge">${m.badge}</span>` : ''}
    </div>`;
  }).join('');
}

function renderScreen(name, navEl) {
  SESSION.currentScreen = name;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  if(navEl) navEl.classList.add('active');
  else {
    const found = document.querySelector(`.nav-item[onclick*="'${name}'"]`);
    if(found) found.classList.add('active');
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const sc = document.getElementById('screen-' + name);
  if(sc) {
    sc.classList.add('active');
    const fn = screens[name];
    if(fn) fn(sc);
  }
}

// ─── SCREENS ────────────────────────────────────────────
const screens = {
  dashboard: renderDashboard,
  reception: renderReception,
  outpatient: renderOutpatient,
  emr: renderEMRList,
  ward: renderWard,
  or: renderOR,
  pharmacy: renderPharmacy,
  pt: renderPT,
  reservation: renderReservation,
  inventory: renderInventory,
  claim: renderClaim,
  stats: renderStats,
  patients: renderPatients,
  health: renderHealth,
  meal: renderMeal,
  nonsurg: renderNonsurg,
  radiology: renderRadiology,
  payment: renderPayment,
  nursing: renderNursing,
  lab: renderLab,
  consent: renderConsent,
  staff: renderStaff,
  settings: renderSettings,
  users: renderUserManagement,
  finance: renderFinance,
  claim_mgmt: renderClaimMgmt,
};

async function fetchDashboardMetrics() {
  // 서버 API 우선 호출, 없으면 로컬 DB로 대체
  try {
    const res = await API.get(API.endpoints.dashboard);
    if(res && res.success && res.data) {
      return res.data;
    }
  } catch(err) {
    console.warn('API dashboard metrics failed, fallback to local DB', err);
  }

  const labCritical = (DB.labResults||[]).filter(l => l.status==='critical' || l.flag==='abnormal').length;
  const pharmacyWait = (DB.prescriptions||[]).filter(p => p.status==='waiting' || p.status==='dur_check').length;
  const alertList = (DB.notifications||[]).filter(n => !n.read && ['lab_critical','dur_warning','vital_alert','stock_low'].includes(n.type));
  const alertMessages = alertList.slice(0,2).map(n => n.message || n.text || '알림');

  return {
    abnormalLab: labCritical,
    pharmacyWait: pharmacyWait,
    anomalyAlerts: alertList.length,
    anomalyExamples: alertMessages,
  };
}


function renderDashboard(el) {
  const today = new Date().toLocaleDateString('ko-KR', {year:'numeric',month:'long',day:'numeric'});
  const user = SESSION.user;
  const role = user ? user.role : 'reception';
  const dept = DB.currentDept;

  // 부서별 맞춤 대시보드
  if (role === 'finance_staff') { renderFinanceDashboard(el); return; }
  if (role === 'claim_staff')   { renderClaimDashboard(el); return; }
  if (role === 'nurse')         { renderNurseDashboard(el); return; }
  if (role === 'pharmacist')    { renderPharmacyDashboard(el); return; }
  if (role === 'hospital_director') { renderDirectorDashboard(el); return; }
  if (role.startsWith('doctor_')) { renderDoctorDashboard(el, dept); return; }

  // 원무/관리자/병원장 — 전체 현황
  el.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div class="section-title" style="margin:0">📊 병원 현황 대시보드 — ${today}</div>
    <div style="font-size:11px;color:var(--text-muted)">마지막 업데이트: ${new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}</div>
  </div>

  <!-- 핵심 KPI -->
  <div class="grid-4" style="margin-bottom:14px">
    <div class="stat-card blue" onclick="renderScreen('outpatient')" style="cursor:pointer">
      <div class="stat-label">오늘 외래 환자</div>
      <div class="stat-value">${DB.patients.length}</div>
      <div class="stat-sub">대기 ${DB.patients.filter(p=>p.status==='대기').length}명 | 진료중 ${DB.patients.filter(p=>p.status==='진료중').length}명</div>
    </div>
    <div class="stat-card green" onclick="renderScreen('ward')" style="cursor:pointer">
      <div class="stat-label">입원 환자</div>
      <div class="stat-value">${DB.wardPatients.length}</div>
      <div class="stat-sub">총 병상 ${getWardActiveCapacity()}개 | 수술후 2명</div>
    </div>
    <div class="stat-card orange" onclick="renderScreen('or')" style="cursor:pointer">
      <div class="stat-label">오늘 수술</div>
      <div class="stat-value">${(DB.surgeries||[]).length}</div>
      <div class="stat-sub">${(function(){var s=DB.surgeries||[];return '완료 '+s.filter(function(x){return x.status==='completed';}).length+' | 진행 '+s.filter(function(x){return x.status==='in_progress';}).length+' | 대기 '+s.filter(function(x){return x.status==='scheduled'||x.status==='prep';}).length;})()}</div>
    </div>
    <div class="stat-card red" onclick="renderScreen('payment')" style="cursor:pointer">
      <div class="stat-label">오늘 수납</div>
      <div class="stat-value" style="font-size:20px">${(function(){var pays=DB.payments||[];var done=pays.filter(function(p){return p.status==='완료';});var amt=done.reduce(function(a,p){return a+(p.amount||0);},0);return done.length===0?'₩0':'₩'+(amt/10000).toFixed(1)+'M';})()}</div>
      <div class="stat-sub">${(function(){var pays=DB.payments||[];return '완료 '+pays.filter(function(p){return p.status==='완료';}).length+' | 대기 '+pays.filter(function(p){return p.status==='대기';}).length+'건';})()}</div>
    </div>
  </div>
  <div class="grid-4" style="margin-bottom:14px">
    <div class="stat-card" style="border-top:3px solid #546e7a;cursor:pointer" onclick="renderScreen('radiology')">
      <div class="stat-label">🩻 영상 판독 대기</div>
      <div class="stat-value">${DB.radiologyImages.filter(i=>i.status!=='판독완료').length}</div>
      <div class="stat-sub">긴급 ${DB.radiologyImages.filter(function(i){return i.urgent;}).length}건 포함</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #e65100;cursor:pointer" onclick="renderScreen('lab')">
      <div class="stat-label">🔬 이상 검사 결과</div>
      <div class="stat-value" id="metric-abnormal-lab">...</div>
      <div class="stat-sub" id="metric-abnormal-lab-sub">로딩중...</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #6a1b9a;cursor:pointer" onclick="renderScreen('pharmacy')">
      <div class="stat-label">💊 조제 대기</div>
      <div class="stat-value" id="metric-pharmacy-wait">...</div>
      <div class="stat-sub" id="metric-pharmacy-sub">로딩중...</div>
    </div>
    <div class="stat-card" style="border-top:3px solid var(--danger);cursor:pointer">
      <div class="stat-label">⚠ 이상징후 알림</div>
      <div class="stat-value" id="metric-anomaly-alert">...</div>
      <div class="stat-sub" id="metric-anomaly-sub">로딩중...</div>
    </div>
  </div>

  <div class="grid-2" style="margin-bottom:14px">
    <!-- 실시간 접수 현황 -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🏥 진료과별 외래 현황</div>
        <button class="btn btn-sm btn-primary" onclick="openModal('modal-reception')">+ 환자 접수</button>
      </div>
      <table>
        <thead><tr><th>진료과</th><th>담당의</th><th>대기</th><th>진료중</th><th>완료</th><th></th></tr></thead>
        <tbody>
          ${(function(){ var dL={ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과·건강검진',anesthesia:'마취통증의학과',health:'건강검진'}; var dR={}; DB.users.filter(function(u){return u.role.startsWith('doctor')||u.role==='hospital_director';}).forEach(function(u){dR[u.dept]=u.name;}); return ['ortho1','ortho2','neuro','internal','anesthesia','health'].map(function(key){ var pts=DB.patients.filter(function(p){return p.dept===key;}); var w=pts.filter(function(p){return p.status==='대기';}).length; var p=pts.filter(function(p){return p.status==='진료중';}).length; var cnt=key==='health'?(DB.reservations||[]).filter(function(r){return r.dept===key&&r.date===new Date().toISOString().substring(0,10);}).length:pts.length; `<tr style="cursor:pointer" onclick="DB.currentDept='${key}';renderScreen('outpatient')">
                <td><strong>${dL[key]||key}</strong></td>
                <td style="font-size:11px">${dR[key]||'-'}</td>
                <td style="text-align:center;color:var(--warning);font-weight:600">${w}</td>
                <td style="text-align:center;color:var(--primary);font-weight:600">${p}</td>
                <td style="font-weight:700;text-align:center">${cnt}</td>
                <td><span class="badge ${cnt>0?'badge-progress':'badge-waiting'}">${cnt>0?'있음':'없음'}</span></td>
              </tr>`; }).join('')})()}
        </tbody>
      </table>
    </div>

    <!-- 오늘 예약 + 긴급 알림 -->
    <div class="card">
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
        ${[
        // DB.notifications에서 자동 생성
          {type:'info', icon:'💊', msg:'클로르족사존 재고 48정 — 안전재고 미달', action:'inventory'},
        ].map(a => `<div onclick="renderScreen('${a.action}')" style="padding:8px 12px;border-radius:6px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:8px;
          background:${a.type==='danger'?'#ffebee':a.type==='warning'?'#fff8e1':'#e3f2fd'};
          border:1px solid ${a.type==='danger'?'#ffcdd2':a.type==='warning'?'#ffe082':'#bbdefb'}">
          <span style="font-size:14px">${a.icon}</span>
          <span>${a.msg}</span>
          <span style="margin-left:auto;font-size:10px;color:var(--text-muted)">→</span>
        </div>`).join('')}
      </div>
      <div class="card-header" style="padding:0;border:none;margin-bottom:8px"><div class="card-title">📅 오늘 예약 현황</div></div>
      ${(function(){
        var td=new Date().toISOString().substring(0,10);
        var rv=(DB.reservations||[]).filter(function(r){return r.date===td;}).slice(0,5);
        var dl={ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',health:'건강검진',anesthesia:'마취통증의학과'};
        if(!rv.length) return '<div style="text-align:center;padding:8px;color:var(--text-muted);font-size:11px">오늘 예약 없음</div>';
        return rv.map(function(r){
          var tp=r.type||'재진';
          var tpBadge=tp==='신환'?'badge-new':tp==='초진'?'badge-first':tp==='검진'?'badge-admit':'badge-revisit';
          return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5;font-size:11px">'+
            '<span style="font-family:var(--mono);font-weight:700;color:var(--primary);min-width:40px">'+r.time+'</span>'+
            '<span style="font-weight:600;flex:1">'+r.patient.split('(')[0].trim()+'</span>'+
            '<span style="color:var(--text-muted)">'+(dl[r.dept]||r.dept||'-')+'</span>'+
            '<span class="badge '+tpBadge+'">'+tp+'</span>'+
          '</div>';
        }).join('');
      })()}
    </div>
  </div>

  <div class="grid-3">
    <!-- 재고 알림 -->
    <div class="card" onclick="renderScreen('inventory')" style="cursor:pointer">
      <div class="card-header"><div class="card-title">⚠ 재고 알림</div><span class="badge badge-urgent">${(DB.inventory||[]).filter(function(i){return i.qty<i.min;}).length}건 부족</span></div>
      ${DB.inventory.filter(i=>i.qty<i.min*1.2).slice(0,4).map(i=>{
        const pct=Math.min(100,Math.round(i.qty/i.min*100));
        return `<div style="margin-bottom:9px">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">${i.name}</span>
            <span style="color:${i.qty<i.min?'var(--danger)':'var(--warning)'};font-weight:700;flex-shrink:0;margin-left:4px">${i.qty} ${i.unit}</span>
          </div>
          <div class="stock-bar"><div class="stock-fill ${i.qty<i.min?'stock-empty':'stock-low'}" style="width:${pct}%"></div></div>
        </div>`;}).join('')}
    </div>

    <!-- 이번달 청구 -->
    <div class="card" onclick="renderScreen('claim_mgmt')" style="cursor:pointer">
      <div class="card-header"><div class="card-title">💰 이번달 청구 현황</div></div>
      ${(function(){
        var pays=DB.payments||[], done=pays.filter(function(p){return p.status==='완료';});
        var amt=done.reduce(function(a,p){return a+(p.amount||0);},0);
        var dels=(DB.claimData&&DB.claimData.deletions)||[];
        var apps=(DB.claimData&&DB.claimData.appeals)||[];
        if(done.length===0) return '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:11px">수납 완료 데이터 없음</div>';
        return '<div style="text-align:center;padding:8px 0 12px">'+
          '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">이번달 수납 완료</div>'+
          '<div style="font-size:26px;font-weight:900;color:var(--primary)">₩'+(amt/10000).toFixed(1)+'M</div>'+
          '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">'+done.length+'건</div></div>'+
          '<div style="display:flex;gap:6px">'+
          '<div style="flex:1;background:#e8f5e9;border-radius:6px;padding:8px;text-align:center"><div style="font-size:9px;color:var(--success);font-weight:600">완료</div><div style="font-size:16px;font-weight:800;color:var(--success)">'+done.length+'</div></div>'+
          '<div style="flex:1;background:#ffebee;border-radius:6px;padding:8px;text-align:center"><div style="font-size:9px;color:var(--danger);font-weight:600">삭감</div><div style="font-size:16px;font-weight:800;color:var(--danger)">'+dels.length+'</div></div>'+
          '<div style="flex:1;background:#f3e5f5;border-radius:6px;padding:8px;text-align:center"><div style="font-size:9px;color:#6a1b9a;font-weight:600">이의</div><div style="font-size:16px;font-weight:800;color:#6a1b9a">'+apps.length+'</div></div>'+
          '</div>';
      })()}
    </div>

    <!-- 오늘 수술 현황 -->
    <div class="card" onclick="renderScreen('or')" style="cursor:pointer">
      <div class="card-header"><div class="card-title">🔪 오늘 수술 현황</div></div>
      ${[
        ...(DB.surgeries||[]).filter(function(s){return s.ptName;}).slice(0,3),
      ].map(s=>`
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f5f5f5">
        <span style="font-family:var(--mono);font-size:10px;color:var(--primary);min-width:40px">${s.time}</span>
        <div style="flex:1">
          <div style="font-size:11px;font-weight:600">${s.ptName||'-'}</div>
          <div style="font-size:10px;color:var(--text-muted)">${s.opName||'-'}</div>
        </div>
        <span class="badge ${s.status==='완료'?'badge-done':s.status==='진행중'?'badge-progress':'badge-waiting'}">${s.status}</span>
      </div>`).join('')}
    </div>
  </div>`;

  // 대시보드 KPI를 DB/API에서 가져와서 수치 업데이트
  fetchDashboardMetrics().then(function(metrics) {
    var elLab = document.getElementById('metric-abnormal-lab');
    var elLabSub = document.getElementById('metric-abnormal-lab-sub');
    var elRx = document.getElementById('metric-pharmacy-wait');
    var elRxSub = document.getElementById('metric-pharmacy-sub');
    var elAlert = document.getElementById('metric-anomaly-alert');
    var elAlertSub = document.getElementById('metric-anomaly-sub');

    if(elLab) {
      elLab.innerText = metrics.abnormalLab;
    }
    if(elLabSub) {
      elLabSub.innerText = metrics.abnormalLab > 0 ? '위험 '+metrics.abnormalLab+'건 즉시 확인 필요' : '위험 없음';
    }
    if(elRx) {
      elRx.innerText = metrics.pharmacyWait;
    }
    if(elRxSub) {
      elRxSub.innerText = metrics.pharmacyWait > 0 ? 'DUR 경고 포함 '+metrics.pharmacyWait+'건' : '조제 대기 없음';
    }
    if(elAlert) {
      elAlert.innerText = metrics.anomalyAlerts;
    }
    if(elAlertSub) {
      elAlertSub.innerText = metrics.anomalyExamples && metrics.anomalyExamples.length > 0 ? metrics.anomalyExamples.join(' | ') : '알림 없음';
    }
  }).catch(function(err){
    console.error('dashboard metrics update failed', err);
  });
}

function renderDoctorDashboard(el, dept) {
  const deptLabel = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',radiology:'영상의학과'}[dept] || dept;
  const myPatients = DB.patients.filter(p => p.dept === dept);
  const today = new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric'});
  el.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div class="section-title" style="margin:0">🏥 ${deptLabel} 진료 현황 — ${today}</div>
    <button class="btn btn-primary" onclick="renderScreen('outpatient')">📋 외래 환자 보기</button>
  </div>
  <div class="grid-4" style="margin-bottom:14px">
    <div class="stat-card blue"><div class="stat-label">오늘 나의 외래</div><div class="stat-value">${myPatients.length}</div><div class="stat-sub">대기 ${myPatients.filter(p=>p.status==='대기').length} | 완료 ${myPatients.filter(p=>p.status==='완료').length}</div></div>
    <div class="stat-card green"><div class="stat-label">담당 입원</div><div class="stat-value">${DB.wardPatients.length}</div><div class="stat-sub">오늘 수술 1건</div></div>
    <div class="stat-card orange"><div class="stat-label">미결 처방</div><div class="stat-value">${(DB.labResults||[]).filter(function(l){return l.status==="critical";}).length}</div><div class="stat-sub">약제실 전송 필요</div></div>
    <div class="stat-card red"><div class="stat-label">긴급 알림</div><div class="stat-value">1</div><div class="stat-sub">영상 판독 대기</div></div>
  </div>
  <div class="grid-2" style="margin-bottom:14px">
    <div class="card">
      <div class="card-header"><div class="card-title">👥 오늘 나의 외래 환자</div><button class="btn btn-sm btn-primary" onclick="renderScreen('outpatient')">전체 보기</button></div>
      ${myPatients.length === 0 ? '<div style="text-align:center;padding:20px;color:var(--text-muted)">오늘 외래 환자 없음</div>' :
      myPatients.map(p=>`<div class="pt-row" onclick="openEMR('${p.id}')" style="cursor:pointer">
        <div class="pt-avatar">${p.name[0]}</div>
        <div class="pt-info">
          <div class="pt-name">${p.name} <small style="color:var(--text-muted)">${p.gender}·${calcAge(p.dob)}세</small></div>
          <div class="pt-meta">${p.id} | ${p.cc} | ${p.type}</div>
        </div>
        <div class="pt-status">
          <span class="badge ${p.status==='대기'?'badge-waiting':p.status==='진료중'?'badge-progress':'badge-done'}">${p.status}</span>
          <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openEMR('${p.id}')">진료</button>
        </div>
      </div>`).join('')}
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">🩻 영상 판독 대기</div></div>
      ${DB.radiologyImages.filter(i=>i.dept===dept).slice(0,4).map(img=>`
      <div onclick="openDicomViewer('${img.id}')" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5;cursor:pointer">
        <span class="modality-badge modality-${img.modality.toLowerCase()}">${img.modality}</span>
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600">${img.ptName} — ${img.body}</div>
          <div style="font-size:10px;color:var(--text-muted)">${img.date}</div>
        </div>
        <span class="img-status-badge ${img.status==='판독완료'?'img-status-done':img.urgent?'img-status-urgent':'img-status-wait'}">${img.status}</span>
      </div>`).join('')}
      ${DB.radiologyImages.filter(i=>i.dept===dept).length===0?'<div style="text-align:center;padding:16px;color:var(--text-muted)">영상 없음</div>':''}
    </div>
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-header"><div class="card-title">📅 예약 현황 (오늘)</div></div>
      ${(function(){
        var td=new Date().toISOString().substring(0,10);
        var rv=(DB.reservations||[]).filter(function(r){return r.date===td&&(r.dept===dept||r.doctor===SESSION.user.id);}).slice(0,5);
        if(!rv.length) return '<div style="text-align:center;padding:8px;color:var(--text-muted);font-size:11px">오늘 예약 없음</div>';
        return rv.map(function(r){
          var tp=r.type||'재진';
          return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5;font-size:11px">'+
            '<span style="font-family:var(--mono);font-weight:700;color:var(--primary);min-width:40px">'+r.time+'</span>'+
            '<span style="font-weight:600;flex:1">'+r.patient.split('(')[0].trim()+'</span>'+
            '<span class="badge '+(tp==='신환'?'badge-new':tp==='초진'?'badge-first':'badge-revisit')+'">'+tp+'</span>'+
          '</div>';
        }).join('');
      })()}    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">📋 담당 입원 환자 활력징후</div></div>
      <table class="vitals-table">
        <thead><tr><th>병상</th><th>환자</th><th>BP</th><th>HR</th><th>BT</th><th>상태</th></tr></thead>
        <tbody>
          ${buildWardVitalsRows()}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderDirectorDashboard(el) {
  var today = new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric'});
  var myPts = DB.patients.filter(function(p){ return p.dept==='ortho1'; });
  var waitCnt  = myPts.filter(function(p){ return p.status==='대기'; }).length;
  var activeCnt= myPts.filter(function(p){ return p.status==='진료중'; }).length;
  var doneCnt  = myPts.filter(function(p){ return p.status==='완료'; }).length;
  var radWait  = DB.radiologyImages.filter(function(i){ return i.dept==='ortho1'&&i.status!=='판독완료'; }).length;

  // 환자 목록 HTML
  var ptListHtml = myPts.length === 0
    ? '<div style="text-align:center;padding:20px;color:var(--text-muted)">오늘 외래 환자 없음</div>'
    : myPts.map(function(p) {
        var typeBadge = p.type==='신환'?'badge-new':p.type==='초진'?'badge-first':'badge-revisit';
        var statusBadge = p.status==='대기'?'badge-waiting':p.status==='진료중'?'badge-progress':'badge-done';
        return '<div class="pt-row" onclick="openEMR(\'' + p.id + '\')" style="cursor:pointer">' +
          '<div class="pt-avatar" style="background:linear-gradient(135deg,#1a4fa0,#2d6fd4)">' + p.name[0] + '</div>' +
          '<div class="pt-info">' +
            '<div class="pt-name">' + p.name + ' <small style="color:var(--text-muted)">' + p.gender + '·' + calcAge(p.dob) + '세</small></div>' +
            '<div class="pt-meta">' + p.id + ' | ' + p.cc + '</div>' +
          '</div>' +
          '<div class="pt-status">' +
            '<span class="badge ' + typeBadge + '" style="font-size:9px">' + p.type + '</span>' +
            '<span class="badge ' + statusBadge + '">' + p.status + '</span>' +
            '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openEMR(\'' + p.id + '\')">진료</button>' +
          '</div>' +
        '</div>';
      }).join('');

  // 영상 판독 HTML
  var radHtml = DB.radiologyImages.filter(function(i){ return i.dept==='ortho1'; }).slice(0,4).map(function(img) {
    var statusClass = img.status==='판독완료'?'img-status-done':img.urgent?'img-status-urgent':'img-status-wait';
    return '<div onclick="openDicomViewer(\'' + img.id + '\')" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5;cursor:pointer">' +
      '<span class="modality-badge modality-' + img.modality.toLowerCase() + '">' + img.modality + '</span>' +
      '<div style="flex:1"><div style="font-size:12px;font-weight:600">' + img.ptName + ' — ' + img.body + '</div>' +
      '<div style="font-size:10px;color:var(--text-muted)">' + img.date + '</div></div>' +
      '<span class="img-status-badge ' + statusClass + '">' + img.status + '</span>' +
    '</div>';
  }).join('');

  // 병동 환자 HTML
  var wardHtml = DB.wardPatients.map(function(wp) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5;font-size:11px">' +
      '<span style="font-weight:700;min-width:40px;color:var(--primary)">' + wp.bed + '</span>' +
      '<span style="font-weight:600;flex:1">' + wp.name + '</span>' +
      '<span style="color:var(--text-muted);font-size:10px">' + wp.diagnosis.substring(0,16) + (wp.diagnosis.length>16?'...':'') + '</span>' +
      '<span class="badge badge-done" style="font-size:9px">' + wp.doctor + '</span>' +
    '</div>';
  }).join('');

  // 진료과별 실적
  var deptStats = [
    {label:'정형외과1 (김창우)', color:'#1a4fa0', cnt:21},
    {label:'정형외과2', color:'#1565c0', cnt:9},
    {label:'신경외과', color:'#4527a0', cnt:8},
    {label:'내과', color:'#00695c', cnt:11},
    {label:'건강검진', color:'#558b2f', cnt:3},
  ];
  var deptHtml = deptStats.map(function(d) {
    return '<div style="margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px"><span>' + d.label + '</span><span style="font-weight:700">' + d.cnt + '명</span></div>' +
      '<div style="height:6px;background:#f0f2f5;border-radius:3px;overflow:hidden"><div style="height:100%;width:' + Math.round(d.cnt/52*100) + '%;background:' + d.color + ';border-radius:3px"></div></div>' +
    '</div>';
  }).join('');

  // 긴급 알림
  var alerts = [
        // DB.notifications 연동
    {type:'warning',icon:'💊',msg:'클로르족사존 재고 부족',action:'inventory'},
    {type:'info',icon:'💰',msg:'이달 청구 마감 D-3',action:'claim_mgmt'},
  ];
  var alertHtml = alerts.map(function(a) {
    var bg    = a.type==='danger'?'#ffebee':a.type==='warning'?'#fff8e1':'#e3f2fd';
    var bord  = a.type==='danger'?'#ffcdd2':a.type==='warning'?'#ffe082':'#bbdefb';
    return '<div onclick="renderScreen(\'' + a.action + '\')" style="padding:7px 10px;border-radius:5px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:7px;margin-bottom:6px;background:' + bg + ';border:1px solid ' + bord + '">' +
      '<span>' + a.icon + '</span><span style="flex:1">' + a.msg + '</span><span style="color:var(--text-muted);font-size:10px">→</span>' +
    '</div>';
  }).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div>' +
        '<div class="section-title" style="margin:0">🏥 김창우 원장 — 정형외과1 + 병원 현황</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:3px">' + today + ' | 병원장 겸 정형외과1 원장</div>' +
      '</div>' +
      '<div class="btn-group">' +
        '<button class="btn btn-outline" onclick="renderScreen(\'outpatient\')">📋 외래 환자 목록</button>' +
        '<button class="btn btn-primary" onclick="openModal(\'modal-reception\')">+ 환자 접수</button>' +
      '</div>' +
    '</div>' +

    // 정형외과1 KPI 배너
    '<div style="background:linear-gradient(135deg,#0d1b35,#1a3a6e);border-radius:10px;padding:14px 18px;margin-bottom:14px;color:#fff">' +
      '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;opacity:0.7;margin-bottom:8px">🦴 정형외과1 — 오늘 나의 진료</div>' +
      '<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center">' +
        '<div style="text-align:center"><div style="font-size:28px;font-weight:900">' + myPts.length + '</div><div style="font-size:10px;opacity:0.8">전체</div></div>' +
        '<div style="text-align:center"><div style="font-size:28px;font-weight:900;color:#ffd54f">' + waitCnt + '</div><div style="font-size:10px;opacity:0.8">대기</div></div>' +
        '<div style="text-align:center"><div style="font-size:28px;font-weight:900;color:#80cbc4">' + activeCnt + '</div><div style="font-size:10px;opacity:0.8">진료중</div></div>' +
        '<div style="text-align:center"><div style="font-size:28px;font-weight:900;color:#a5d6a7">' + doneCnt + '</div><div style="font-size:10px;opacity:0.8">완료</div></div>' +
        '<div style="margin-left:auto;font-size:11px;opacity:0.8">영상 판독 대기: <strong>' + radWait + '건</strong> | 수술: <strong>2건</strong></div>' +
      '</div>' +
    '</div>' +

    '<div class="grid-2" style="margin-bottom:14px">' +
      '<div class="card"><div class="card-header"><div class="card-title">👥 오늘 나의 환자 (정형외과1)</div></div>' + ptListHtml + '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">🩻 영상 판독 (정형외과1)</div></div>' + (radHtml || '<div style="text-align:center;padding:16px;color:var(--text-muted)">없음</div>') + '</div>' +
    '</div>' +

    // 병원 전체 경영
    '<div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid var(--border)">📊 병원 전체 경영 현황</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue" onclick="renderScreen(\'outpatient\')" style="cursor:pointer"><div class="stat-label">오늘 전체 외래</div><div class="stat-value">' + DB.patients.length + '</div><div class="stat-sub">5개 진료과</div></div>' +
      (function(){var pays=DB.payments||[];var done=pays.filter(function(p){return p.status==='완료';});var amt=done.reduce(function(a,p){return a+(p.amount||0);},0);return '<div class="stat-card green" onclick="renderScreen(\'payment\')" style="cursor:pointer"><div class="stat-label">오늘 수납</div><div class="stat-value" style="font-size:20px">₩'+(done.length===0?'0':(amt/10000).toFixed(1)+'M')+'</div><div class="stat-sub">완료 '+done.length+' | 대기 '+pays.filter(function(p){return p.status==='대기';}).length+'</div></div>';})() +
      '<div class="stat-card orange" onclick="renderScreen(\'finance\')" style="cursor:pointer"><div class="stat-label">이달 순이익</div><div class="stat-value" style="font-size:20px">₩55M</div><div class="stat-sub">영업이익률 22.8%</div></div>' +
      (function(){var dels=(DB.claimData&&DB.claimData.deletions)||[];var pays=DB.payments||[];var totalAmt=pays.filter(function(p){return p.status==='완료';}).reduce(function(a,p){return a+(p.amount||0);},0);var delAmt=dels.reduce(function(a,d){return a+(d.amount||d.amt||0);},0);var rate=totalAmt>0?(delAmt/totalAmt*100).toFixed(2):'0.00';return '<div class="stat-card red" onclick="renderScreen(\'claim_mgmt\')" style="cursor:pointer"><div class="stat-label">청구 삭감률</div><div class="stat-value">'+rate+'%</div><div class="stat-sub">'+(parseFloat(rate)<1.2?'양호':'주의 필요')+'</div></div>';})() +
    '</div>' +

    '<div class="grid-3">' +
      '<div class="card" onclick="renderScreen(\'ward\')" style="cursor:pointer"><div class="card-header"><div class="card-title">🛏 입원 환자 현황</div></div>' + wardHtml + '</div>' +
      '<div class="card" onclick="renderScreen(\'stats\')" style="cursor:pointer"><div class="card-header"><div class="card-title">📊 진료과별 실적</div></div>' + deptHtml + '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">⚡ 긴급 알림</div></div>' + alertHtml + '</div>' +
    '</div>';
}

function renderNurseDashboard(el) {
  var medRows = [
    {time:'06:00',pt:'전체',drug:'아침약 투여 완료',done:true},
    {time:'-', pt:'전체', drug:'투약 대기', done:false},
    {time:'12:00',pt:'전체',drug:'점심약 예정',done:false},
    {time:'-',pt:'입원환자',drug:'PRN 투약 예정',done:false},
  ];
  var medHtml = medRows.map(function(m) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:11px">' +
      '<span style="font-family:var(--mono);color:var(--primary);min-width:42px;font-weight:600">' + m.time + '</span>' +
      '<span style="font-weight:600;min-width:52px">' + m.pt + '</span>' +
      '<span style="flex:1;color:' + (m.done?'var(--text-muted)':'inherit') + ';text-decoration:' + (m.done?'line-through':'none') + '">' + m.drug + '</span>' +
      '<span style="font-size:14px">' + (m.done?'✅':'⭕') + '</span>' +
    '</div>';
  }).join('');

  var todos = [
    {done:true,  task:'06:00 전체 V/S 측정'},
    {done:true,  task:'아침 투약 완료'},
    {done:false, task:'드레싱 교환 예정'},
    {done:false, task:'혈압 이상 환자 재측정'},
    {done:false, task:'투약 지시 확인'},
    {done:false, task:'입원기록지 작성'},
  ];
  var todoHtml = todos.map(function(t) {
    return '<div class="checklist-item' + (t.done?' done':'') + '" onclick="this.classList.toggle(\'done\')">' +
      '<div class="checklist-cb">' + (t.done?'✓':'') + '</div>' +
      '<span class="checklist-label">' + t.task + '</span>' +
    '</div>';
  }).join('');

  el.innerHTML =
    '<div class="section-title">💉 간호 현황 대시보드</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">담당 환자</div><div class="stat-value">' + DB.wardPatients.length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">⚠ 이상징후</div><div class="stat-value">2</div><div class="stat-sub">즉시 확인 필요</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">투약 예정</div><div class="stat-value">8</div><div class="stat-sub">다음 09:00</div></div>' +
      '<div class="stat-card green"><div class="stat-label">드레싱 예정</div><div class="stat-value">2</div></div>' +
    '</div>' +
    '<div class="grid-2" style="margin-bottom:14px">' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">🛏 병동 환자 활력징후</div>' +
        '<button class="btn btn-sm btn-primary" onclick="openModal(\'modal-nursing\')">+ V/S 입력</button></div>' +
        '<table class="vitals-table"><thead><tr><th>병상</th><th>환자</th><th>BP</th><th>HR</th><th>BT</th><th>SpO₂</th><th>VAS</th><th>상태</th></tr></thead><tbody>' +
          buildWardVitalsRows() +
        '</tbody></table>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">💊 오늘 투약 일정</div>' +
        '<button class="btn btn-sm btn-outline" onclick="renderScreen(\'nursing\')">전체 MAR</button></div>' +
        medHtml +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">📝 오늘 간호 TODO</div></div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' + todoHtml + '</div>' +
    '</div>';
}

function renderPharmacyDashboard(el) {
  var lowDrugCnt = DB.inventory.filter(function(i){ return i.qty<i.min && i.category==='약품'; }).length;
  el.innerHTML =
    '<div class="section-title">💊 약제실 대시보드</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">조제 대기</div><div class="stat-value">8</div></div>' +
      '<div class="stat-card red"><div class="stat-label">DUR 경고</div><div class="stat-value">2</div><div class="stat-sub">즉시 확인</div></div>' +
      '<div class="stat-card green"><div class="stat-label">오늘 조제 완료</div><div class="stat-value">31</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">재고 부족</div><div class="stat-value">' + lowDrugCnt + '</div></div>' +
    '</div>' +
    '<div class="grid-2">' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">📋 조제 대기 목록</div>' +
        '<button class="btn btn-sm btn-primary" onclick="renderScreen(\'pharmacy\')">전체 보기</button></div>' +
        (DB.prescriptions&&DB.prescriptions.filter(function(p){return p.status==='waiting'||p.status==='dur_check';}).length>0 ? DB.prescriptions.filter(function(p){return p.status==='waiting'||p.status==='dur_check';}).slice(0,4).map(function(p,i){return p.ptName+' ('+p.drugCount+'종)';}) : ['처방 대기 없음']).map(function(n,i){
          return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f5f5f5;font-size:12px">' +
            '<span style="width:20px;height:20px;border-radius:50%;background:var(--primary);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + (i+1) + '</span>' +
            '<span style="flex:1;font-weight:600">' + n + '</span>' +
            (i<2 ? '<span class="badge badge-urgent" style="font-size:9px">DUR</span>' : '') +
            '<button class="btn btn-sm btn-primary" onclick="completeDispense(\'PH-00' + (i+1) + '\')">완료</button>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">⚠ DUR 경고</div></div>' +
        (DB.prescriptions&&DB.prescriptions.some(function(p){return p.durWarning;}) ? DB.prescriptions.filter(function(p){return p.durWarning;}).map(function(p){return '<div class="claim-warn '+(p.durLevel==="error"?"error":"warning")+'"><span class="claim-icon">'+(p.durLevel==="error"?"🚫":"⚠")+"</span><div><strong>"+p.ptName+"</strong> — "+p.durType+": "+p.durMessage+"</div></div>";}).join('') : '<div style="text-align:center;padding:12px;font-size:11px;color:var(--success)">✓ DUR 경고 없음</div>') +
        ((DB.prescriptions||[]).some(function(p){return p.durWarning;})? '' : '') +
      '</div>' +
    '</div>';
}

function renderFinanceDashboard(el) {
  el.innerHTML =
    '<div class="section-title">💵 재무과 대시보드</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card green"><div class="stat-label">이번달 수입</div><div class="stat-value" style="font-size:20px">₩241M</div></div>' +
      '<div class="stat-card red"><div class="stat-label">이번달 지출</div><div class="stat-value" style="font-size:20px">₩186M</div></div>' +
      '<div class="stat-card blue"><div class="stat-label">순이익</div><div class="stat-value" style="font-size:20px">₩55M</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">미수금</div><div class="stat-value" style="font-size:20px">₩8.4M</div></div>' +
    '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">빠른 메뉴</div></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn btn-primary" onclick="renderScreen(\'finance\')">💵 재무 현황</button>' +
        '<button class="btn btn-outline" onclick="renderScreen(\'payment\')">💰 수납 현황</button>' +
        '<button class="btn btn-outline" onclick="renderScreen(\'stats\')">📊 통계</button>' +
      '</div>' +
    '</div>';
}

function renderClaimDashboard(el) {
  el.innerHTML =
    '<div class="section-title">🏥 심사청구과 대시보드</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      (function(){var n=(DB.payments||[]).filter(function(p){return p.status==='완료';}).length;return '<div class="stat-card blue"><div class="stat-label">이번달 청구</div><div class="stat-value">'+n+'건</div></div>';})() +
      '<div class="stat-card green"><div class="stat-label">인정</div><div class="stat-value">340건</div></div>' +
      (function(){var dels=(DB.claimData&&DB.claimData.deletions)||[];var delAmt=dels.reduce(function(a,d){return a+(d.amount||d.amt||0);},0);return '<div class="stat-card red"><div class="stat-label">삭감</div><div class="stat-value">'+dels.length+'건</div><div class="stat-sub">'+(delAmt>0?'₩'+delAmt.toLocaleString():'없음')+'</div></div>';})() +
      '<div class="stat-card orange"><div class="stat-label">이의신청</div><div class="stat-value">1건</div><div class="stat-sub">진행중</div></div>' +
    '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">빠른 메뉴</div></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn btn-primary" onclick="renderScreen(\'claim_mgmt\')">🏥 청구 관리</button>' +
        '<button class="btn btn-outline" onclick="renderScreen(\'stats\')">📊 청구 통계</button>' +
      '</div>' +
    '</div>';
}

function renderReception(el) {
  el.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div class="section-title" style="margin:0">📝 오늘 접수 현황 <small style="font-size:11px;font-weight:400;color:var(--text-muted)">— 오늘 접수된 외래 환자</small></div>
    <div class="btn-group">
      <select class="form-control" style="width:auto" onchange="filterPatients(this.value)">
        <option value="">전체 진료과</option>
        <option value="ortho1">정형외과1</option>
        <option value="ortho2">정형외과2</option>
        <option value="neuro">신경외과</option>
        <option value="internal">내과</option>
      </select>
      <button class="btn btn-primary" onclick="openModal('modal-reception')">+ 환자 접수</button>
    </div>
  </div>
  <div class="card">
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>접수번호</th><th>환자명</th><th>성/나이</th><th>보험유형</th><th>구분</th><th>진료과</th><th>담당의</th><th>주소</th><th>접수시간</th><th>상태</th><th>관리</th></tr></thead>
        <tbody id="reception-tbody">
          ${DB.patients.map((p,i) => renderPatientRow(p, i)).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderPatientRow(p, i) {
  const deptLabel = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',health:'건강검진',pt:'물리치료',nonsurg:'비수술',or:'수술실',ward:'병동',pharmacy:'약제실'}[p.dept] || p.dept;
  const statusBadge = p.status==='대기' ? 'badge-waiting' : p.status==='진료중' || p.status==='치료중' || p.status==='검진중' ? 'badge-progress' : 'badge-done';
  return `<tr onclick="openEMR('${p.id}')" style="cursor:pointer">
    <td><span style="font-family:var(--mono);font-size:11px;color:var(--primary)">${p.id}</span></td>
    <td><strong>${p.name}</strong></td>
    <td>${p.gender} · ${calcAge(p.dob)}세</td>
    <td><span style="font-size:11px">${p.insurance}</span></td>
    <td><span class="badge ${p.type==='신환'?'badge-new':p.type==='초진'?'badge-first':'badge-revisit'}">${p.type}</span></td>
    <td>${deptLabel}</td>
    <td>${p.doctor}</td>
    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${p.cc}</td>
    <td><span style="font-family:var(--mono);font-size:11px">${p.registered}</span></td>
    <td><span class="badge ${statusBadge}">${p.status}</span></td>
    <td onclick="event.stopPropagation()">
      <div class="btn-group">
        <button class="btn btn-sm btn-outline" onclick="openEMR('${p.id}')">진료</button>
        <button class="btn btn-sm btn-ghost" onclick="cancelRecept('${p.id}')">취소</button>
      </div>
    </td>
  </tr>`;
}

function renderOutpatient(el) {
  var user    = SESSION.user;
  var role    = user ? user.role : 'reception';
  var myDept  = user ? user.dept : 'reception';
  var isAdmin = role === 'admin' || role === 'hospital_director';

  // 현재 선택된 진료과 (admin은 여러 진료과 탭 이동 가능)
  if(!el._dept) el._dept = myDept;
  var dept = el._dept;

  var deptLabel = {
    ortho1:'정형외과1', ortho2:'정형외과2', neuro:'신경외과',
    internal:'내과·건강검진', anesthesia:'마취통증의학과',
    health:'건강검진', pt:'물리치료', nonsurg:'비수술', all:'전체'
  };

  // 환자 목록: 의사는 본인 진료과 / admin은 선택 진료과 or 전체
  var allPatients = DB.patients || [];
  var deptPatients = (dept === 'all')
    ? allPatients
    : allPatients.filter(function(p){ return p.dept === dept; });

  // 검색 필터
  var searchQ = el._search || '';
  if(searchQ) {
    deptPatients = deptPatients.filter(function(p){
      return p.name.includes(searchQ) || (p.id||'').includes(searchQ) || (p.cc||'').includes(searchQ);
    });
  }

  // 진료과 탭 (admin/병원장만)
  var tabsHtml = '';
  if(isAdmin) {
    var tabDepts = [
      {key:'all', label:'전체'},
      {key:'ortho1', label:'정형1'}, {key:'ortho2', label:'정형2'},
      {key:'neuro', label:'신경외과'}, {key:'internal', label:'내과'},
      {key:'anesthesia', label:'마취'}, {key:'health', label:'건강검진'},
    ];
    tabsHtml = '<div style="display:flex;gap:4px;padding:8px;border-bottom:1px solid var(--border);flex-wrap:wrap">' +
      tabDepts.map(function(t){
        var cnt = t.key==='all' ? allPatients.length : allPatients.filter(function(p){return p.dept===t.key;}).length;
        var isActive = dept === t.key;
        return '<button onclick="document.getElementById(\'screen-outpatient\')._dept=\''+t.key+'\';document.getElementById(\'screen-outpatient\')._search=\'\';renderOutpatient(document.getElementById(\'screen-outpatient\'))" ' +
          'style="padding:4px 10px;border-radius:4px;font-size:11px;font-weight:600;border:1.5px solid ' + (isActive?'var(--primary)':'var(--border)') + ';' +
                 'background:' + (isActive?'var(--primary)':'#fff') + ';color:' + (isActive?'#fff':'inherit') + ';cursor:pointer">' +
          t.label + (cnt>0?' <span style="background:' + (isActive?'rgba(255,255,255,0.3)':'#e53935') + ';color:#fff;border-radius:8px;padding:0 4px;font-size:9px">'+cnt+'</span>':'') +
        '</button>';
      }).join('') +
    '</div>';
  }

  // 상태별 카운트
  var waiting   = deptPatients.filter(function(p){return p.status==='대기';}).length;
  var inprogress= deptPatients.filter(function(p){return p.status==='진료중';}).length;
  var done      = deptPatients.filter(function(p){return p.status==='완료';}).length;

  // 환자 행
  function ptRow(p) {
    var typeBadge = p.type==='신환'?'badge-new':p.type==='초진'?'badge-first':'badge-revisit';
    var stBadge   = p.status==='대기'?'badge-waiting':p.status==='진료중'?'badge-progress':'badge-done';
    return '<div class="pt-row" id="ptrow-'+p.id+'" onclick="selectOutpatient(\''+p.id+'\')" style="position:relative">' +
      '<div class="pt-avatar">' + (p.name||'?')[0] + '</div>' +
      '<div class="pt-info">' +
        '<div class="pt-name">' + p.name + '</div>' +
        '<div class="pt-meta">' + calcAge(p.dob) + '세 ' + p.gender + ' · ' + (p.cc||'-') + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted)">' + (p.doctor||'-') + ' | ' + (deptLabel[p.dept]||p.dept||'-') + '</div>' +
      '</div>' +
      '<div class="pt-status">' +
        '<span class="badge ' + typeBadge + '">' + p.type + '</span>' +
        '<span class="badge ' + stBadge + '">' + p.status + '</span>' +
      '</div>' +
    '</div>';
  }

  el.innerHTML =
    '<div class="split-layout">' +
      '<div class="split-left">' +
        // 헤더
        '<div class="split-left-header">' +
          '<span style="font-size:12px;font-weight:700">' + (deptLabel[dept]||'외래') + ' 환자 목록</span>' +
          '<div style="display:flex;gap:6px;align-items:center">' +
            '<span class="badge badge-waiting">' + waiting + '명 대기</span>' +
            (inprogress>0?'<span class="badge badge-progress">'+inprogress+'명 진료중</span>':'') +
          '</div>' +
        '</div>' +
        // 진료과 탭 (admin만)
        tabsHtml +
        // 검색
        '<div style="padding:8px;border-bottom:1px solid var(--border)">' +
          '<input class="form-control" style="font-size:12px" placeholder="이름·접수번호·증상 검색..." ' +
            'value="' + searchQ + '" ' +
            'oninput="document.getElementById(\'screen-outpatient\')._search=this.value;renderOutpatient(document.getElementById(\'screen-outpatient\'))">' +
        '</div>' +
        // 환자 목록
        (deptPatients.length === 0
          ? '<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">' +
              '<div style="font-size:36px;margin-bottom:12px">🏥</div>' +
              '<div style="font-size:13px;font-weight:600;margin-bottom:8px">' +
                (allPatients.length===0 ? '오늘 접수된 환자가 없습니다' : (deptLabel[dept]||dept)+' 환자가 없습니다') +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-bottom:16px">접수 화면에서 환자를 접수하면 여기에 표시됩니다</div>' +
              '<button class="btn btn-primary" onclick="openModal(\'modal-reception\')">+ 환자 접수</button>' +
            '</div>'
          : deptPatients.map(ptRow).join('')) +
      '</div>' +
      '<div class="split-right">' +
        '<div id="outpatient-detail" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">' +
          '<div style="text-align:center">' +
            '<div style="font-size:48px;margin-bottom:12px">👈</div>' +
            '<div style="font-size:14px;font-weight:500">환자를 선택하면 진료 정보가 표시됩니다</div>' +
            '<div style="font-size:11px;margin-top:8px">' +
              '대기 ' + waiting + '명 · 진료중 ' + inprogress + '명 · 완료 ' + done + '명' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
}


function selectOutpatient(pid) {
  document.querySelectorAll('.pt-row').forEach(r => r.classList.remove('active'));
  const row = document.getElementById('ptrow-' + pid);
  if(row) row.classList.add('active');
  const p = DB.patients.find(x => x.id === pid);
  if(!p) return;
  document.getElementById('outpatient-detail').innerHTML = `
  <div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:16px;padding:4px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
      <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;font-weight:800">${p.name[0]}</div>
      <div>
        <div style="font-size:18px;font-weight:700">${p.name} <span style="font-size:13px;font-weight:400;color:var(--text-muted)">${p.gender} · ${calcAge(p.dob)}세</span></div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:3px">${p.id} | ${p.insurance} | 📞 ${p.phone}</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <span class="badge ${p.type==='신환'?'badge-new':p.type==='초진'?'badge-first':'badge-revisit'}" style="font-size:12px;padding:4px 10px">${p.type}</span>
        <span class="badge ${p.status==='대기'?'badge-waiting':p.status==='진료중'?'badge-progress':'badge-done'}" style="font-size:12px;padding:4px 10px">${p.status}</span>
      </div>
    </div>
    <div class="grid-3" style="gap:8px;margin-bottom:12px">
      <div><div style="font-size:10px;color:var(--text-muted);font-weight:600;margin-bottom:2px">주소(CC)</div><div style="font-size:12px">${p.cc}</div></div>
      <div><div style="font-size:10px;color:var(--text-muted);font-weight:600;margin-bottom:2px">담당의</div><div style="font-size:12px">${p.doctor}</div></div>
      <div><div style="font-size:10px;color:var(--text-muted);font-weight:600;margin-bottom:2px">접수시간</div><div style="font-size:12px;font-family:var(--mono)">${p.registered}</div></div>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="openEMR('${p.id}')">📋 진료 시작</button>
      <button class="btn btn-outline" onclick="printPatientReceipt('${p.id}')">🖨 접수증 출력</button>
      <button class="btn btn-warning" onclick="openModal('modal-prescription')">💊 처방전 조회</button>
      <button class="btn btn-ghost" onclick="showPatientHistory('${p.id}')">📁 이전 기록</button>
    </div>
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">진료 이력</div></div>
    <div class="timeline">
      ${(function(){
        var master=DB.patientMaster.find(function(m){return m.pid===p.id;});
        var hist=master?master.visitHistory:[];
        if(hist.length===0) return '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px">이전 진료 이력 없음</div>';
        var deptMap={ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',health:'건강검진',pt:'물리치료'};
        return hist.slice().reverse().map(function(v){
          var dl=deptMap[v.dept]||v.dept;
          var c=DB.emrCharts.find(function(c2){return c2.visitId===v.visitId&&c2.entryType==='original';});
          var s=c&&c.soap?c.soap.S.substring(0,70):'차트 미작성';
          var tb=v.visitType==='신환'?'badge-new':v.visitType==='초진'?'badge-first':'badge-revisit';
          return '<div class="timeline-item">'+
            '<div class="timeline-date">'+v.date+' ('+dl+') — <span class="badge '+tb+'" style="font-size:9px">'+(v.visitType||'')+'</span></div>'+
            '<div class="timeline-content"><strong>'+(v.diagName||v.icd10||'진단 미기재')+'</strong>'+(v.icd10?' <span style="font-family:var(--mono);font-size:10px;color:var(--primary)">(' +v.icd10+')</span>':'')+
            '<br><span style="font-size:11px;color:var(--text-muted)">'+s+'</span>'+
            (c?'<button class="btn btn-sm btn-ghost" style="font-size:10px;padding:2px 6px;margin-left:6px" onclick="openEMR(\'' + p.id + '\')">' + '차트 보기</button>':'')+
            '</div></div>';
        }).join('');
      })()}
    </div>
  </div>`;
}

function renderEMRList(el) {
  el.innerHTML = `
  <div class="section-title">📋 진료 기록 조회</div>
  <div class="card" style="margin-bottom:16px">
    <div class="form-row">
      <div class="form-group"><label>기간</label>
        <div style="display:flex;gap:6px">
          <input class="form-control" type="date" value="2025-01-01">
          <span style="align-self:center;color:var(--text-muted)">~</span>
          <input class="form-control" type="date" id="stat-from-date">
        </div>
      </div>
      <div class="form-group"><label>환자명</label><input class="form-control" placeholder="이름 검색"></div>
      <div class="form-group"><label>진료과</label>
        <select class="form-control"><option>전체</option><option>정형외과1</option><option>정형외과2</option><option>신경외과</option><option>내과</option></select>
      </div>
      <button class="btn btn-primary" style="align-self:flex-end">검색</button>
    </div>
  </div>
  <div class="card">
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>날짜</th><th>환자명</th><th>나이/성별</th><th>구분</th><th>진료과</th><th>담당의</th><th>진단명</th><th>처방</th><th>관리</th></tr></thead>
        <tbody>
          ${DB.patients.map(p => `<tr>
            <td style="font-family:var(--mono);font-size:11px">-</td>
            <td><strong>${p.name}</strong></td>
            <td>${calcAge(p.dob)}세 ${p.gender}</td>
            <td><span class="badge ${p.type==='신환'?'badge-new':p.type==='초진'?'badge-first':'badge-revisit'}">${p.type}</span></td>
            <td>${{ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',health:'건강검진',pt:'물리치료'}[p.dept]||p.dept}</td>
            <td>${p.doctor}</td>
            <td style="max-width:180px"><small>M51.1 추간판 변성</small></td>
            <td><span style="font-size:11px;color:var(--text-muted)">약물 3종, 물리치료</span></td>
            <td>
              <div class="btn-group">
                <button class="btn btn-sm btn-outline" onclick="openEMR('${p.id}')">보기</button>
                <button class="btn btn-sm btn-ghost">출력</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function getWardRoomCapacity(bedNum) {
  if(!DB.wardRoomTypes) DB.wardRoomTypes = {};
  var cap = DB.wardRoomTypes[bedNum];
  return Number(cap === undefined || cap === null ? 1 : cap);
}

function getWardActiveCapacity() {
  var total = 0;
  ['5','6','7'].forEach(function(prefix){
    for(var i=1; i<=10; i++) {
      var bedNum = prefix + (i < 10 ? '0' + i : i);
      var cap = getWardRoomCapacity(bedNum);
      if(cap > 0) total += cap;
    }
  });
  return total;
}

function getWingActiveCapacity(wingId) {
  var total = 0;
  for(var i=1; i<=10; i++) {
    var bedNum = wingId + (i < 10 ? '0' + i : i);
    var cap = getWardRoomCapacity(bedNum);
    if(cap > 0) total += cap;
  }
  return total;
}

function setWardRoomCapacity(bedNum, cap) {
  if(!DB.wardRoomTypes) DB.wardRoomTypes = {};
  DB.wardRoomTypes[bedNum] = Number(cap);
  notify('병실 설정', bedNum + '호를 ' + (cap===0 ? '미사용' : cap + '인실') + '로 설정했습니다.', 'success');
  renderScreen('ward');
}

function renderWard(el) {
  var wards = DB.wardPatients || [];
  var activeWards = wards.filter(function(w){
    var b = (w.bed||'').replace('호','');
    return getWardRoomCapacity(b) > 0;
  });
  var total = activeWards.length;
  var todayDischarge = wards.filter(function(w){return w.status==='퇴원예정';}).length;
  var isolated = wards.filter(function(w){return w.isolation;}).length;

  // 5병동/6병동/7병동 구성
  var WINGS = [
    {id:'5', label:'5병동', beds:['501','502','503','504','505','506','507','508','509','510']},
    {id:'6', label:'6병동', beds:['601','602','603','604','605','606','607','608','609','610']},
    {id:'7', label:'7병동', beds:['701','702','703','704','705','706','707','708','709','710']},
  ];

    function bedCard(bedNum) {
    var roomCap = getWardRoomCapacity(bedNum);
    if(roomCap === 0) { return ''; }
    var bed = bedNum + '호';
    var wp = wards.find(function(w){ return w.bed === bed; });
    var capLabel = roomCap === 1 ? '1인실' : roomCap + '인실';
    if(wp) {
      var bpAlert = wp.vitals && parseInt((wp.vitals.bp||'0').split('/')[0]) > 160;
      var cardStyle = bpAlert ? 'border-color:#ef9a9a;background:#ffebee' : '';
      return '<div class="bed-card occupied' + (bpAlert?' bed-alert':'') + '" onclick="showWardPatient(\'' + bed.replace(/'/g,"\\'") + '\')" style="' + cardStyle + '">' +
        '<div class="bed-num">' + bedNum + '호</div>' +
        '<div style="font-size:10px;color:#666;font-weight:600;margin-bottom:2px">' + capLabel + '</div>' +
        '<div class="bed-name" style="font-size:11px;font-weight:600;margin-top:4px">' + wp.name + '</div>' +
        '<div class="bed-meta" style="font-size:10px">' + (wp.age||'') + '세 ' + (wp.gender||'') + '</div>' +
        '<div class="bed-meta" style="color:var(--primary);font-size:10px">' + (wp.doctor||'-') + '</div>' +
        (bpAlert ? '<div style="font-size:9px;color:#c62828;font-weight:700">⚠ BP↑</div>' : '') +
      '</div>';
    } else {
      return '<div class="bed-card empty" onclick="openAdmitToBed(\'' + bedNum + '\')" title="클릭하여 입원 등록">' +
        '<div class="bed-num">' + bedNum + '호</div>' +
        '<div style="font-size:10px;color:#666;font-weight:600;margin-bottom:2px">' + capLabel + '</div>' +
        '<div class="bed-meta" style="margin-top:8px;color:var(--success);font-size:11px">공실</div>' +
      '</div>';
    }
  }

  var activeBedCount = getWardActiveCapacity();

  var roomConfigHtml = '<div class="card" style="margin-bottom:16px">' +
      '<div class="card-header"><div class="card-title">🛠 병실 타입 설정 (관리자)</div></div>' +
      '<div style="padding:12px;display:grid;grid-template-columns:repeat(5,1fr);gap:8px">';

  WINGS.forEach(function(wing){
    wing.beds.forEach(function(bedNum){
      var cap = getWardRoomCapacity(bedNum);
      roomConfigHtml += '<div style="font-size:11px">' +
        '<div style="font-weight:700;margin-bottom:4px">' + bedNum + '호</div>' +
        '<select class="form-control" style="width:100%;font-size:11px" onchange="setWardRoomCapacity(\'' + bedNum + '\', this.value)">' +
          '<option value="0"' + (cap===0?' selected':'') + '>미사용</option>' +
          '<option value="1"' + (cap===1?' selected':'') + '>1인실</option>' +
          '<option value="2"' + (cap===2?' selected':'') + '>2인실</option>' +
          '<option value="3"' + (cap===3?' selected':'') + '>3인실</option>' +
          '<option value="4"' + (cap===4?' selected':'') + '>4인실</option>' +
          '<option value="5"' + (cap===5?' selected':'') + '>5인실</option>' +
          '<option value="6"' + (cap===6?' selected':'') + '>6인실</option>' +
        '</select>' +
      '</div>';
    });
  });

  roomConfigHtml += '</div></div>';

  var wingHtml = WINGS.map(function(wing){
    var wingPts = activeWards.filter(function(w){return w.bed && w.bed.startsWith(wing.id);});
    var activeWingBeds = getWingActiveCapacity(wing.id);
    return '<div class="card" style="margin-bottom:14px">' +
      '<div class="card-header">' +
        '<div class="card-title">🛏 ' + wing.label + '</div>' +
        '<span style="font-size:11px;color:var(--text-muted)">입원 ' + wingPts.length + '명 / ' + activeWingBeds + '병상</span>' +
      '</div>' +
      '<div class="bed-grid" style="grid-template-columns:repeat(5,1fr)">' +
        wing.beds.map(bedCard).join('') +
      '</div>' +
    '</div>';
  }).join('');

  var listHtml = wards.length === 0
    ? '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">입원 환자 없음 — "입원 등록" 버튼으로 환자를 등록하세요</td></tr>'
    : wards.map(function(wp){
        return '<tr>' +
          '<td><strong>' + wp.bed + '</strong></td>' +
          '<td>' + wp.name + ' <small style="color:var(--text-muted)">(' + (wp.age||'')+'/'+(wp.gender||'') + ')</small></td>' +
          '<td style="max-width:150px;font-size:11px">' + (wp.diagnosis||'-') + '</td>' +
          '<td style="font-family:var(--mono);font-size:11px">' + (wp.admitDate||'-') + '</td>' +
          '<td><span class="meal-tag ' + ({당뇨식:'meal-tag-diabetic',연식:'meal-tag-soft',저염식:'meal-tag-soft',금식:'meal-tag-diabetic'}[wp.diet]||'meal-tag-normal') + '">' + (wp.diet||'일반식') + '</span></td>' +
          '<td><div class="btn-group">' +
            '<button class="btn btn-sm btn-outline" onclick="showWardPatient(\'' + wp.bed + '\')">상세</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="openDischarge(\'' + wp.bed + '\')">퇴원</button>' +tton>' +">퇴원</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">🛏 입원 병동 현황</div>' +
      '<button class="btn btn-primary" onclick="openAdmit()">+ 입원 등록</button>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:16px">' +
      '<div class="stat-card blue"><div class="stat-label">입원 환자</div><div class="stat-value">' + total + '</div><div class="stat-sub">5·6·7병동 총 ' + activeBedCount + '병상</div></div>' +
      '<div class="stat-card green"><div class="stat-label">퇴원 예정</div><div class="stat-value">' + todayDischarge + '</div><div class="stat-sub">오늘 퇴원</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">빈 병상</div><div class="stat-value">' + Math.max(0, activeBedCount-total) + '</div><div class="stat-sub">예약 가능</div></div>' +
      '<div class="stat-card red"><div class="stat-label">격리 환자</div><div class="stat-value">' + isolated + '</div></div>' +
    '</div>' +
    roomConfigHtml +
    wingHtml +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">👥 입원 환자 목록</div></div>' +
      '<div class="tbl-wrap"><table>' +
        '<thead><tr><th>병상</th><th>환자명</th><th>진단</th><th>입원일</th><th>식단</th><th>관리</th></tr></thead>' +
        '<tbody>' + listHtml + '</tbody>' +
      '</table></div>' +
    '</div>';
}

function openDischarge(bed) {
  if(confirm(bed + ' 환자를 퇴원 처리하시겠습니까?')) {
    DB.wardPatients = DB.wardPatients.filter(function(w){return w.bed!==bed;});
    DB.auditLog.push({time:new Date().toISOString(),action:'DISCHARGE',user:SESSION.user?SESSION.user.username:'-',bed:bed});
    notify('퇴원 처리', bed + ' 퇴원 처리 완료', 'success');
    renderScreen('ward');
  }
}


// ─── SHARED HELPERS ─────────────────────────────────────
function buildDeptLabel(dept) {
  var map = {
    ortho1:'정형외과1', ortho2:'정형외과2', neuro:'신경외과',
    internal:'내과·건강검진', anesthesia:'마취통증의학과',
    radiology:'진단영상의학과', health:'건강검진',
    pt:'물리치료', nonsurg:'비수술', or:'수술실',
    ward:'병동', pharmacy:'약제실', reception:'원무',
    finance:'재무과', claim_mgmt:'심사청구과', admin:'관리',
  };
  return map[dept] || dept;
}

function buildWardVitalsRows() {
  if (!DB.wardPatients || DB.wardPatients.length === 0) {
    return '<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--text-muted)">입원 환자 없음</td></tr>';
  }
  return DB.wardPatients.slice(0, 4).map(function(wp) {
    var v = wp.vitals || {};
    var bp = v.bp || '-';
    var alert = v.bp && parseInt(bp.split('/')[0]) > 160;
    return '<tr' + (alert ? ' style="background:#fff5f5"' : '') + '>' +
      '<td>' + wp.bed + '</td><td>' + wp.name + '</td>' +
      '<td' + (alert ? ' class="lab-H"' : '') + '>' + bp + '</td>' +
      '<td>' + (v.hr||'-') + '</td><td>' + (v.bt||'-') + '</td>' +
      '<td>' + (v.spo2||'-') + '</td><td>' + (v.vas||'-') + '</td>' +
      '<td>' + (v.time||'-') + '</td>' +
    '</tr>';
  }).join('');
}

function openDynamicModal(id, titleHtml, bodyHtml, footerHtml) {
  var overlay = document.getElementById(id);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  }
  overlay.innerHTML = '<div class="modal" style="max-width:580px">' +
    '<div class="modal-header">' + titleHtml +
    '<button class="modal-close" onclick="document.getElementById(\'' + id + '\').classList.remove(\'open\')">✕</button></div>' +
    '<div class="modal-body">' + bodyHtml + '</div>' +
    '<div class="modal-footer">' + footerHtml + '</div>' +
  '</div>';
  overlay.classList.add('open');
}

// ─── 수술 등록 ──────────────────────────────────────────
function openAddSurgeryModal() {
  // 수술 등록 권한: 의사 또는 병원장만 가능
  if(SESSION.user) {
    var role = SESSION.user.role;
    if(!role.startsWith('doctor_') && role !== 'hospital_director' && role !== 'admin') {
      notify('권한 오류', '수술 등록은 의사만 가능합니다.', 'error');
      return;
    }
  }

  // 심평원 수술행위료 목록 (건강보험 행위 급여 목록 고시 기준)
  var OP_LIST = {
    '척추 수술': [
      {c:'N2401',n:'추간판제거술-경추 (1추간)'},
      {c:'N2403',n:'추간판제거술-요추 (1추간)'},
      {c:'N2405',n:'추간판제거술-요추 미세현미경 (L4-5)'},
      {c:'N2406',n:'추간판제거술-요추 미세현미경 (L5-S1)'},
      {c:'N2407',n:'추간판제거술-경추 미세현미경 (ACDF포함)'},
      {c:'N2408',n:'추간판제거술-흉추 미세현미경'},
      {c:'N2411',n:'인공추간판치환술-경추 (1분절)'},
      {c:'N2412',n:'인공추간판치환술-경추 (2분절)'},
      {c:'N2413',n:'인공추간판치환술-요추 (1분절)'},
      {c:'N2421',n:'척추후방유합술 PLIF (1분절)'},
      {c:'N2422',n:'척추후방유합술 PLIF (2분절)'},
      {c:'N2423',n:'척추후방유합술 PLIF (3분절 이상)'},
      {c:'N2431',n:'척추전방유합술 ALIF (1분절)'},
      {c:'N2432',n:'척추전방유합술 ALIF (2분절 이상)'},
      {c:'N2441',n:'측방 추간체유합술 XLIF/LLIF (1분절)'},
      {c:'N2451',n:'척추경유추간공유합술 TLIF (1분절)'},
      {c:'N2452',n:'척추경유추간공유합술 TLIF (2분절)'},
      {c:'N2453',n:'척추경유추간공유합술 TLIF (3분절 이상)'},
      {c:'N2461',n:'척추경 나사못고정술 (2분절, 양측)'},
      {c:'N2462',n:'척추경 나사못고정술 (3분절 이상, 양측)'},
      {c:'N2471',n:'경피적 척추성형술 (1추체)'},
      {c:'N2472',n:'경피적 척추성형술 (2추체 이상)'},
      {c:'N2481',n:'척추관협착증 감압술 (편측, 1분절)'},
      {c:'N2482',n:'척추관협착증 감압술 (양측, 1분절)'},
      {c:'N2483',n:'척추관협착증 감압술 (양측, 2분절)'},
      {c:'N2491',n:'후궁절제술 (Laminectomy, 1분절)'},
      {c:'N2492',n:'반후궁절제술 (Hemilaminectomy)'},
      {c:'N2501',n:'척추측만증 교정술 (후방, 3분절 이상)'},
      {c:'N2511',n:'척추 골절 감압술 및 내고정술'},
      {c:'N2521',n:'미세침습 척추수술 (MIS-TLIF)'},
      {c:'N2531',n:'내시경 척추수술 (PELD, 경피적)'},
      {c:'N2532',n:'내시경 척추수술 (UBE, 단방향)'},
    ],
    '관절 수술': [
      {c:'N2071',n:'슬관절 전치환술 TKR (편측)'},
      {c:'N2072',n:'슬관절 전치환술 TKR (양측, 동시)'},
      {c:'N2073',n:'슬관절 부분치환술 UKA (내측)'},
      {c:'N2074',n:'슬관절 부분치환술 UKA (외측)'},
      {c:'N2075',n:'슬관절 재치환술 (revision TKR)'},
      {c:'N2081',n:'고관절 전치환술 THA (편측)'},
      {c:'N2082',n:'고관절 반치환술 (Bipolar Hemi)'},
      {c:'N2083',n:'고관절 재치환술 (revision THA)'},
      {c:'N2091',n:'견관절 전치환술 TSA'},
      {c:'N2092',n:'역형 견관절치환술 rTSA'},
      {c:'N2101',n:'반월상연골판 부분절제술 (관절경)'},
      {c:'N2102',n:'반월상연골판 봉합술 (관절경, All-inside)'},
      {c:'N2103',n:'반월상연골판 이식술 (동종)'},
      {c:'N2111',n:'전방십자인대 재건술 ACL (관절경, 자가건)'},
      {c:'N2112',n:'전방십자인대 재건술 ACL (관절경, 동종건)'},
      {c:'N2113',n:'후방십자인대 재건술 PCL (관절경)'},
      {c:'N2114',n:'다발인대 재건술 (복합)'},
      {c:'N2121',n:'슬관절 활막절제술 (관절경)'},
      {c:'N2131',n:'발목관절 유합술 (관절경)'},
      {c:'N2132',n:'발목관절 전치환술 TAR'},
      {c:'N2141',n:'견봉하 감압술 ASD (관절경)'},
      {c:'N2151',n:'회전근개 봉합술 (관절경, 부분파열)'},
      {c:'N2152',n:'회전근개 봉합술 (관절경, 완전파열 소)'},
      {c:'N2153',n:'회전근개 봉합술 (관절경, 완전파열 대·광범위)'},
      {c:'N2161',n:'SLAP 봉합술 (상방 관절순)'},
      {c:'N2171',n:'방카르트 수복술 (전방 불안정, 관절경)'},
      {c:'N2181',n:'팔꿈치 측부인대 재건술'},
      {c:'N2191',n:'손목 삼각섬유연골복합체 TFCC 봉합술'},
      {c:'N2201',n:'연골 수복술 (골연골 이식, 단일)'},
      {c:'N2202',n:'자가 연골세포 이식술 ACI'},
      {c:'N2211',n:'골절 관혈적 정복 및 내고정술 (대퇴골)'},
      {c:'N2212',n:'골절 관혈적 정복 및 내고정술 (경골)'},
      {c:'N2213',n:'골절 관혈적 정복 및 내고정술 (상완골)'},
      {c:'N2221',n:'내고정물 제거술 (plate/nail)'},
    ],
    '신경외과': [
      {c:'N2301',n:'뇌종양 제거술 (두개강내, 두개강외)'},
      {c:'N2302',n:'두개강내 종양 제거술 (현미경)'},
      {c:'N2311',n:'뇌동맥류 결찰술 (개두술)'},
      {c:'N2312',n:'뇌동맥류 혈관내 코일색전술'},
      {c:'N2321',n:'경막외 혈종 제거술 (응급)'},
      {c:'N2331',n:'경막하 혈종 제거술 (만성, 천공술)'},
      {c:'N2332',n:'경막하 혈종 제거술 (급성, 개두술)'},
      {c:'N2341',n:'두개강내 압력 감시장치 삽입술'},
      {c:'N2351',n:'수두증 단락술 (V-P shunt)'},
      {c:'N2361',n:'뇌심부자극술 DBS (편측)'},
      {c:'N2371',n:'척수 종양 제거술 (경막내 수외)'},
      {c:'N2372',n:'척수 종양 제거술 (경막내 수내)'},
      {c:'N2381',n:'말초신경 봉합술'},
      {c:'N2391',n:'수근관 유리술 (손목터널증후군)'},
      {c:'N2392',n:'팔꿈치관절 척골신경 감압술'},
    ],
    '마취 수기': [
      {c:'L5001',n:'전신마취 (ASA I-II, 30분 이내)'},
      {c:'L5010',n:'전신마취 (ASA I-II, 1시간 이내)'},
      {c:'L5011',n:'전신마취 (ASA I-II, 2시간 이내)'},
      {c:'L5012',n:'전신마취 (ASA I-II, 4시간 이내)'},
      {c:'L5013',n:'전신마취 (ASA I-II, 4시간 초과)'},
      {c:'L5021',n:'전신마취 (ASA III-IV 고위험)'},
      {c:'L5030',n:'척추마취 (지주막하강내차단)'},
      {c:'L5040',n:'경막외마취 (지속적)'},
      {c:'L5050',n:'전완신경총차단 (초음파 유도)'},
      {c:'L5060',n:'수술후 통증관리 PCA (IV)'},
      {c:'L5061',n:'수술후 통증관리 PCA (경막외)'},
    ],
  };

  var drOpts = DB.users.filter(function(u){
    return u.status==='active' && (u.role==='hospital_director'||u.role.startsWith('doctor_'));
  }).map(function(u){
    var dl={ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',anesthesia:'마취통증의학과',internal:'내과'};
    return '<option value="'+u.name+'">'+u.name+' ('+(dl[u.dept]||u.dept)+')</option>';
  }).join('');

  // 본인 자동 선택
  var defaultDr = SESSION.user ? SESSION.user.name : '';

  var opOpts = Object.entries(OP_LIST).map(function(entry){
    return '<optgroup label="── '+entry[0]+' ──">' +
      entry[1].map(function(o){
        return '<option value="['+o.c+'] '+o.n+'">['+o.c+'] '+o.n+'</option>';
      }).join('') +
    '</optgroup>';
  }).join('');

  openDynamicModal('modal-add-surgery',
    '<div class="modal-title">🔪 수술 등록</div>',
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 환자명</label><input class="form-control" id="surg-pt" placeholder="환자명"></div>' +
      '<div class="form-group"><label>* 수술 시간</label><input class="form-control" type="time" id="surg-time" value="09:00"></div>' +
      '<div class="form-group" style="grid-column:span 2">' +
        '<label>* 수술명 <small style="color:var(--text-muted);font-weight:400">심평원 행위코드 기준 · ' + Object.values(OP_LIST).reduce(function(a,v){return a+v.length;},0) + '종</small></label>' +
        '<select class="form-control" id="surg-opname" style="margin-bottom:5px"><option value="">-- 수술명 선택 --</option>' + opOpts + '</select>' +
        '<input class="form-control" id="surg-opname-custom" placeholder="목록에 없는 경우 직접 입력 (직접 입력이 선택보다 우선)">' +
      '</div>' +
      '<div class="form-group"><label>* 집도의</label>' +
        '<select class="form-control" id="surg-surgeon">' + drOpts + '</select>' +
      '</div>' +
      '<div class="form-group"><label>마취 방법</label>' +
        '<select class="form-control" id="surg-anes">' +
          '<option>전신마취</option><option>척추마취</option><option>경막외마취</option><option>국소마취</option><option>복합마취</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>수술실</label>' +
        '<select class="form-control" id="surg-room"><option>OR-1</option><option>OR-2</option><option>OR-3</option></select>' +
      '</div>' +
      '<div class="form-group"><label>예상 소요 시간</label>' +
        '<select class="form-control" id="surg-est-time">' +
          '<option>1시간 이내</option><option>1~2시간</option><option>2~3시간</option><option>3~4시간</option><option>4시간 이상</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" style="grid-column:span 2"><label>수술 전 특이사항 / 주의</label>' +
        '<input class="form-control" id="surg-note" placeholder="알레르기, 기저질환, 주의사항 등">' +
      '</div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-add-surgery\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveSurgery()">✓ 수술 등록</button>'
  );

  // 집도의 본인 자동 선택
  setTimeout(function(){
    var sel = document.getElementById('surg-surgeon');
    if(sel && defaultDr) {
      Array.from(sel.options).forEach(function(o){ if(o.value===defaultDr) o.selected=true; });
    }
  }, 50);
}



// ─── 카카오 예약 설정 모달 ────────────────────────────────
function openKakaoReservationInfo() {
  openDynamicModal('modal-kakao-info',
    '<div class="modal-title">💬 카카오톡 예약 설정</div>',
    '<div style="background:#FEE500;border-radius:10px;padding:14px;margin-bottom:14px;display:flex;align-items:center;gap:12px">' +
      '<div style="font-size:28px">💬</div>' +
      '<div><div style="font-weight:800;font-size:14px;color:#1A1A1A">카카오 채널 예약 연동</div>' +
        '<div style="font-size:11px;color:#3A3A3A;margin-top:3px">카카오 비즈니스 채널과 연동하면 환자가 카카오톡으로 예약할 수 있습니다</div>' +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>카카오 채널 ID</label>' +
      '<input class="form-control" id="kakao-channel-id" placeholder="@정동병원 (채널 아이디 입력)"></div>' +
    '<div class="form-group"><label>카카오 비즈 API 키</label>' +
      '<input class="form-control" id="kakao-api-key" placeholder="카카오 비즈니스 API 키" type="password"></div>' +
    '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:8px">' +
      '<div style="font-weight:700;font-size:12px;margin-bottom:8px">📋 카카오 예약 운영 현황</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">' +
        '<div><span style="color:var(--text-muted)">카카오 예약 총계:</span> <strong>' + (DB.reservations||[]).filter(function(r){return r.source==='kakao';}).length + '건</strong></div>' +
        '<div><span style="color:var(--text-muted)">이번달:</span> <strong>' + (function(){var m=new Date().toISOString().substring(0,7);return (DB.reservations||[]).filter(function(r){return r.source==='kakao'&&(r.date||'').startsWith(m);}).length;})() + '건</strong></div>' +
      '</div>' +
    '</div>' +
    '<div style="margin-top:12px;background:#f8fafd;border-radius:8px;padding:10px 12px;font-size:11px;color:var(--text-muted)">' +
      '<div style="font-weight:700;color:var(--text-primary);margin-bottom:6px">💡 카카오 예약 링크 공유 방법</div>' +
      '<div style="margin-bottom:4px">1. 하단의 "예약 페이지 미리보기"로 환자용 UI를 확인하세요</div>' +
      '<div style="margin-bottom:4px">2. 카카오 채널 관리자에서 예약 버튼에 아래 URL을 연결하세요</div>' +
      '<div style="background:#fff;border-radius:4px;padding:6px 10px;font-family:monospace;font-size:11px;margin-top:4px;word-break:break-all">' +
        window.location.href.split('?')[0] + '?kakao=1' +
      '</div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-kakao-info\').classList.remove(\'open\')">닫기</button>' +
    '<button class="btn btn-outline" onclick="openKakaoPreview()">👁 환자용 예약 페이지 미리보기</button>' +
    '<button class="btn btn-primary" onclick="notify(\'저장\',\'카카오 채널 설정이 저장되었습니다.\',\'success\');document.getElementById(\'modal-kakao-info\').classList.remove(\'open\')">✓ 저장</button>'
  );
}

// ─── 카카오 환자용 예약 페이지 (팝업) ────────────────────
function openKakaoPreview() {
  // 환자용 예약 UI를 별도 오버레이로 표시
  var overlay = document.getElementById('modal-kakao-preview');
  if(!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-kakao-preview';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = buildKakaoResvPage();
  overlay.style.display = 'flex';
}

function buildKakaoResvPage() {
  var today = new Date().toISOString().substring(0,10);
  var depts = [
    {val:'ortho1',label:'정형외과1'},
    {val:'ortho2',label:'정형외과2'},
    {val:'neuro', label:'신경외과'},
    {val:'internal',label:'내과'},
    {val:'anesthesia',label:'마취통증의학과'},
    {val:'health',label:'건강검진센터'},
  ];
  var deptOpts = depts.map(function(d){return '<option value="'+d.val+'">'+d.label+'</option>';}).join('');

  return '<div id="kakao-page" style="background:#fff;border-radius:16px;width:380px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)">' +
    // 헤더
    '<div style="background:#FEE500;padding:16px 20px;border-radius:16px 16px 0 0;display:flex;align-items:center;gap:10px">' +
      '<div style="font-size:24px">💬</div>' +
      '<div>' +
        '<div style="font-weight:800;font-size:15px;color:#1A1A1A">정동병원 예약</div>' +
        '<div style="font-size:11px;color:#3A3A3A">카카오톡으로 간편하게 예약하세요</div>' +
      '</div>' +
      '<button onclick="document.getElementById(\'modal-kakao-preview\').style.display=\'none\'" style="margin-left:auto;background:none;border:none;font-size:20px;cursor:pointer;color:#1A1A1A">✕</button>' +
    '</div>' +
    // 진행 단계
    '<div style="display:flex;padding:14px 20px;gap:0;border-bottom:1px solid #f0f0f0" id="kakao-steps">' +
      stepBubble(1, '정보 입력', true) +
      '<div style="flex:1;height:1px;background:#ddd;align-self:center;margin:0 4px"></div>' +
      stepBubble(2, '날짜/시간', false) +
      '<div style="flex:1;height:1px;background:#ddd;align-self:center;margin:0 4px"></div>' +
      stepBubble(3, '확인', false) +
    '</div>' +
    // 본문 (step 1: 환자 정보)
    '<div id="kakao-step-1" style="padding:20px">' +
      '<div style="font-weight:700;font-size:14px;margin-bottom:14px">환자 정보 입력</div>' +
      '<div style="margin-bottom:10px">' +
        '<label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">* 이름</label>' +
        '<input id="kk-name" style="width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 12px;font-size:14px;box-sizing:border-box;outline:none" placeholder="홍길동">' +
      '</div>' +
      '<div style="margin-bottom:10px">' +
        '<label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">* 휴대폰 번호</label>' +
        '<input id="kk-phone" style="width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 12px;font-size:14px;box-sizing:border-box;outline:none" placeholder="010-0000-0000" type="tel">' +
      '</div>' +
      '<div style="margin-bottom:10px">' +
        '<label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">* 진료과 선택</label>' +
        '<select id="kk-dept" style="width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 12px;font-size:14px;box-sizing:border-box;background:#fff;outline:none">' +
          '<option value="">-- 선택하세요 --</option>' + deptOpts +
        '</select>' +
      '</div>' +
      '<div style="margin-bottom:14px">' +
        '<label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">방문 목적</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          ['초진','재진','신환','건강검진'].map(function(t){
            return '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px">' +
              '<input type="radio" name="kk-type" value="'+t+'" '+(t==='재진'?'checked':'')+'>'+t+'</label>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div style="margin-bottom:14px">' +
        '<label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">증상/요청사항</label>' +
        '<textarea id="kk-memo" style="width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 12px;font-size:13px;box-sizing:border-box;min-height:70px;resize:none;outline:none" placeholder="주요 증상이나 요청사항을 입력해주세요"></textarea>' +
      '</div>' +
      '<button onclick="kakaoStep2()" style="width:100%;background:#FEE500;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:800;color:#1A1A1A;cursor:pointer">다음 — 날짜/시간 선택 →</button>' +
    '</div>' +
  '</div>';
}

function stepBubble(n, label, active) {
  return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px">' +
    '<div style="width:24px;height:24px;border-radius:50%;background:'+(active?'#FEE500':'#f0f0f0')+';display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:'+(active?'#1A1A1A':'#bbb')+'">'+n+'</div>' +
    '<div style="font-size:10px;color:'+(active?'#1A1A1A':'#bbb')+'">'+label+'</div>' +
  '</div>';
}

function kakaoStep2() {
  var name  = (document.getElementById('kk-name')||{}).value||'';
  var phone = (document.getElementById('kk-phone')||{}).value||'';
  var dept  = (document.getElementById('kk-dept')||{}).value||'';
  if(!name||!phone||!dept) { alert('이름, 휴대폰 번호, 진료과를 모두 입력해주세요'); return; }

  // 날짜 선택 화면으로 전환
  var step1 = document.getElementById('kakao-step-1');
  if(!step1) return;
  step1.innerHTML =
    '<div style="font-weight:700;font-size:14px;margin-bottom:14px">날짜 선택</div>' +
    buildKakaoCalendar() +
    '<div style="margin-top:14px" id="kk-time-area"></div>' +
    '<div style="margin-top:14px" id="kk-confirm-area"></div>';
}

function buildKakaoCalendar() {
  var today = new Date();
  var year = today.getFullYear(), month = today.getMonth();
  var firstDay = new Date(year, month, 1).getDay();
  var lastDate = new Date(year, month+1, 0).getDate();
  var days = ['일','월','화','수','목','금','토'];

  var html = '<div style="background:#f8f8f8;border-radius:10px;overflow:hidden">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#FEE500">' +
      '<span style="font-weight:800;font-size:13px">' + year + '년 ' + (month+1) + '월</span>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center">' +
    days.map(function(d,i){
      return '<div style="padding:6px 2px;font-size:11px;font-weight:700;color:'+(i===0?'#e53935':i===6?'#1565c0':'#555')+'">'+d+'</div>';
    }).join('');

  for(var i=0; i<firstDay; i++) html += '<div></div>';
  for(var d=1; d<=lastDate; d++) {
    var dateStr = year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var dow = new Date(year, month, d).getDay();
    var isPast = new Date(dateStr) < new Date(today.toISOString().substring(0,10));
    var isHoliday = isKoreanHoliday(year, month+1, d);
    var isClosed = dow===0 || isHoliday;
    var isToday2 = d===today.getDate();

    if(isClosed || isPast) {
      html += '<div style="padding:8px 2px;text-align:center;font-size:12px;color:#ccc;cursor:not-allowed">' +
        '<div style="width:28px;height:28px;margin:auto;display:flex;align-items:center;justify-content:center">' + d + '</div>' +
      '</div>';
    } else {
      html += '<div onclick="selectKakaoDate(\'' + dateStr + '\')" style="padding:8px 2px;text-align:center;cursor:pointer">' +
        '<div style="width:28px;height:28px;margin:auto;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:12px;font-weight:600;' +
          (isToday2 ? 'background:#FEE500;font-weight:800;' : '') +
          'color:'+(dow===0||isHoliday?'#e53935':dow===6?'#1565c0':'#333')+'">' + d + '</div>' +
      '</div>';
    }
  }

  html += '</div></div>';
  return html;
}

function selectKakaoDate(dateStr) {
  var dept = (document.getElementById('kk-dept')||{}).value||'';
  var slots = getAvailableSlots(dateStr, dept);
  var timeArea = document.getElementById('kk-time-area');
  if(!timeArea) return;

  if(slots.length===0) {
    timeArea.innerHTML = '<div style="text-align:center;padding:12px;color:#e53935;font-size:13px">해당 날짜는 진료가 없습니다</div>';
    return;
  }

  timeArea.innerHTML =
    '<div style="font-weight:700;font-size:13px;margin-bottom:10px">' + dateStr + ' 시간 선택</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
    slots.map(function(s) {
      var avail = !s.full;
      return '<button onclick="' + (avail?'selectKakaoTime(\'' + dateStr + '\',\'' + s.time + '\')':'') + '" ' +
        'style="padding:8px 12px;border-radius:8px;font-size:13px;font-weight:600;border:1.5px solid ' + (avail?'#FEE500':'#e0e0e0') + ';' +
        'background:' + (avail?'#FFF9C4':'#f5f5f5') + ';color:' + (avail?'#1A1A1A':'#bbb') + ';' +
        'cursor:' + (avail?'pointer':'not-allowed') + '">' +
        s.time + (s.full?' (마감)':'') +
      '</button>';
    }).join('') +
    '</div>';
  document.getElementById('kk-confirm-area').innerHTML = '';
}

function selectKakaoTime(dateStr, time) {
  var confirmArea = document.getElementById('kk-confirm-area');
  if(!confirmArea) return;
  var name  = (document.getElementById('kk-name')||{}).value||'';
  var phone = (document.getElementById('kk-phone')||{}).value||'';
  var deptEl = document.getElementById('kk-dept');
  var dept  = deptEl ? deptEl.value : '';
  var deptLabels = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과·건강검진',anesthesia:'마취통증의학과',health:'건강검진센터'};
  var typeEl = document.querySelector('input[name="kk-type"]:checked');
  var type  = typeEl ? typeEl.value : '재진';
  var memo  = (document.getElementById('kk-memo')||{}).value||'';

  confirmArea.innerHTML =
    '<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-top:4px">' +
      '<div style="font-weight:700;font-size:13px;margin-bottom:10px">예약 내용 확인</div>' +
      '<div style="font-size:12px;line-height:2">' +
        '<div>👤 <strong>'+name+'</strong> ('+phone+')</div>' +
        '<div>🏥 '+( deptLabels[dept]||dept)+'</div>' +
        '<div>📅 '+dateStr+' '+time+'</div>' +
        '<div>🔖 '+type+'</div>' +
        (memo?'<div>📝 '+memo+'</div>':'') +
      '</div>' +
    '</div>' +
    '<button onclick="submitKakaoReservation(\'' + dateStr + '\',\'' + time + '\')" ' +
      'style="width:100%;background:#FEE500;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:800;color:#1A1A1A;cursor:pointer;margin-top:12px">' +
      '💬 예약 확정하기' +
    '</button>';
}

function submitKakaoReservation(dateStr, time) {
  var name  = (document.getElementById('kk-name')||{}).value.trim()||'';
  var phone = (document.getElementById('kk-phone')||{}).value.trim()||'';
  var deptEl = document.getElementById('kk-dept');
  var dept  = deptEl ? deptEl.value : '';
  var typeEl = document.querySelector('input[name="kk-type"]:checked');
  var type  = typeEl ? typeEl.value : '재진';
  var memo  = (document.getElementById('kk-memo')||{}).value||'';

  // 마감 재확인
  var slots = getAvailableSlots(dateStr, dept);
  var slot = slots.find(function(s){return s.time===time;});
  if(!slot || slot.full) {
    alert('죄송합니다. 방금 해당 시간이 마감되었습니다. 다른 시간을 선택해주세요.');
    return;
  }

  var resv = {
    id: 'KK-'+Date.now(), date:dateStr, time:time, dept:dept,
    patient: name, doctor: '-', type: type,
    phone: phone, memo: memo, status: '확정',
    source: 'kakao',
    createdAt: new Date().toISOString(),
  };
  if(!DB.reservations) DB.reservations = [];
  DB.reservations.push(resv);
  DB.auditLog.push({time:new Date().toISOString(),action:'KAKAO_RESERVATION',patient:name,date:dateStr,time:time,dept:dept});
  DB.notifications.push({id:'NTF-'+Date.now(),type:'new_reservation',level:'info',
    message:'💬 카카오 예약: '+name+' '+dateStr+' '+time+' ('+dept+')',time:new Date().toISOString(),read:false});

  // 완료 화면
  var page = document.getElementById('kakao-page');
  if(page) {
    page.innerHTML =
      '<div style="padding:40px 24px;text-align:center">' +
        '<div style="font-size:56px;margin-bottom:16px">✅</div>' +
        '<div style="font-weight:800;font-size:18px;margin-bottom:8px">예약이 완료되었습니다!</div>' +
        '<div style="background:#f8f8f8;border-radius:12px;padding:16px;margin:16px 0;font-size:13px;line-height:2;text-align:left">' +
          '<div>👤 <strong>'+name+'</strong></div>' +
          '<div>📅 <strong>'+dateStr+' '+time+'</strong></div>' +
          '<div>🏥 '+({ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',anesthesia:'마취통증의학과',health:'건강검진센터'}[dept]||dept)+'</div>' +
        '</div>' +
        '<div style="font-size:12px;color:#888;margin-bottom:20px">예약 확인 카카오톡 알림이 발송됩니다<br>변경/취소는 병원 대표번호로 문의하세요</div>' +
        '<button onclick="document.getElementById(\'modal-kakao-preview\').style.display=\'none\'" ' +
          'style="background:#FEE500;border:none;border-radius:10px;padding:12px 32px;font-size:15px;font-weight:800;color:#1A1A1A;cursor:pointer">닫기</button>' +
      '</div>';
  }
  notify('카카오 예약', '💬 '+name+' '+dateStr+' '+time+' 카카오 예약이 등록되었습니다.', 'success');
}


function saveSurgery() {
  var ptEl = document.getElementById('surg-pt');
  var opEl = document.getElementById('surg-opname');
  var opCustomEl = document.getElementById('surg-opname-custom');
  var opName = (opCustomEl && opCustomEl.value.trim()) || (opEl && opEl.value) || '';
  if (!ptEl || !ptEl.value.trim()) { notify('입력 오류', '환자명을 입력하세요.', 'error'); return; }
  if (!opName) { notify('입력 오류', '수술명을 선택하거나 입력하세요.', 'error'); return; }
  var surg = {
    id: 'SRG-' + Date.now(),
    date: new Date().toISOString().substring(0, 10),
    time: document.getElementById('surg-time').value,
    ptName: ptEl.value.trim(),
    opName: opName,
    surgeon: document.getElementById('surg-surgeon').value,
    anesthesia: document.getElementById('surg-anes').value,
    room: document.getElementById('surg-room').value,
    note: document.getElementById('surg-note').value,
    status: 'scheduled',
    createdBy: SESSION.user ? SESSION.user.id : 'USR-001',
  };
  DB.surgeries.push(surg);
  DB.auditLog.push({ time: new Date().toISOString(), action: 'SURGERY_REGISTERED',
    user: SESSION.user ? SESSION.user.username : '-', opName: surg.opName });
  document.getElementById('modal-add-surgery').classList.remove('open');
  notify('수술 등록', surg.time + ' ' + surg.opName + ' 등록 완료', 'success');
  renderScreen('or');
}

function updateSurgeryStatus(id) {
  var s = (DB.surgeries || []).find(function(x) { return x.id === id; });
  if (!s) return;
  var next = { scheduled: 'prep', prep: 'in_progress', in_progress: 'completed' }[s.status];
  if (next) {
    s.status = next;
    if (next === 'in_progress') s.startTime = new Date().toISOString();
    if (next === 'completed') { s.endTime = new Date().toISOString(); }
    renderScreen('or');
    notify('상태 변경', s.ptName + ' ' + s.opName + ' → ' +
      ({prep:'준비중', in_progress:'진행중', completed:'완료'}[next]||next), 'info');
  }
}

// ─── 물리치료 등록 ──────────────────────────────────────
function openAddPTModal() {
  var drOpts = DB.users.filter(function(u){return u.status==='active'&&(u.role==='hospital_director'||u.role.startsWith('doctor_'));}).map(function(u){return '<option>'+u.name+'</option>';}).join('');
  var typeOpts = ['도수치료', '전기치료 (ES)', '핫팩 + 초음파', '경피신경전기자극 (TENS)', '견인치료', '레이저치료', '운동치료', '복합치료']
    .map(function(t){ return '<option>' + t + '</option>'; }).join('');

  openDynamicModal('modal-add-pt',
    '<div class="modal-title">🏃 물리치료 등록</div>',
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 환자명</label><input class="form-control" id="pt-sched-pt" placeholder="환자명"></div>' +
      '<div class="form-group"><label>* 처방의</label><select class="form-control" id="pt-sched-dr">' + drOpts + '</select></div>' +
      '<div class="form-group" style="grid-column:span 2"><label>* 치료 종류</label><select class="form-control" id="pt-sched-type">' + typeOpts + '</select></div>' +
      '<div class="form-group"><label>이번주 횟수</label><input class="form-control" type="number" id="pt-sched-week" value="1" min="1" max="5"></div>' +
      '<div class="form-group"><label>주 최대 허용</label><input class="form-control" type="number" id="pt-sched-max" value="5" min="1" max="5"></div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-add-pt\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="savePTSchedule()">✓ 등록</button>'
  );
}

function savePTSchedule() {
  var ptEl = document.getElementById('pt-sched-pt');
  if (!ptEl || !ptEl.value.trim()) { notify('입력 오류', '환자명을 입력하세요.', 'error'); return; }
  DB.ptSchedules.push({
    id: 'PT-' + Date.now(), ptName: ptEl.value.trim(),
    doctor: document.getElementById('pt-sched-dr').value,
    treatType: document.getElementById('pt-sched-type').value,
    weekCount: parseInt(document.getElementById('pt-sched-week').value) || 1,
    weekMax: parseInt(document.getElementById('pt-sched-max').value) || 5,
    status: 'waiting', date: new Date().toISOString().substring(0, 10),
  });
  document.getElementById('modal-add-pt').classList.remove('open');
  notify('등록 완료', '물리치료 스케줄이 등록되었습니다.', 'success');
  renderScreen('pt');
}

function completePTSession(id) {
  var s = (DB.ptSchedules || []).find(function(x) { return x.id === id; });
  if (s) { s.status = 'completed'; s.completedAt = new Date().toISOString(); }
  renderScreen('pt');
  notify('완료', '치료가 완료 처리되었습니다.', 'success');
}

// ─── 비수술 시술 등록 ───────────────────────────────────
function openAddNonsurgModal() {
  var drOpts = DB.users.filter(function(u){return u.status==='active'&&(u.role==='hospital_director'||u.role.startsWith('doctor_'));}).map(function(u){return '<option>'+u.name+'</option>';}).join('');
  var typeOpts = ['경막외 신경차단술 (ESI)', '선택적 신경근차단술 (SNRB)', '프롤로치료', '체외충격파치료 (ESWT)', '인대강화주사 (PRP)', '관절강내 주사', '신경성형술 (Neuroplasty)']
    .map(function(t){ return '<option>' + t + '</option>'; }).join('');

  openDynamicModal('modal-add-nonsurg',
    '<div class="modal-title">💉 비수술 시술 등록</div>',
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 환자명</label><input class="form-control" id="ns-pt" placeholder="환자명"></div>' +
      '<div class="form-group"><label>* 처방의</label><select class="form-control" id="ns-dr">' + drOpts + '</select></div>' +
      '<div class="form-group" style="grid-column:span 2"><label>* 시술명</label><select class="form-control" id="ns-type">' + typeOpts + '</select></div>' +
      '<div class="form-group"><label>시술 부위</label><input class="form-control" id="ns-site" placeholder="예: L4-5, 우측 슬관절"></div>' +
      '<div class="form-group"><label>급여 구분</label><select class="form-control" id="ns-covered"><option value="true">급여</option><option value="false">비급여</option></select></div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-add-nonsurg\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveNonsurg()">✓ 등록</button>'
  );
}

function saveNonsurg() {
  var ptEl = document.getElementById('ns-pt');
  if (!ptEl || !ptEl.value.trim()) { notify('입력 오류', '환자명을 입력하세요.', 'error'); return; }
  DB.ptSchedules.push({
    id: 'NS-' + Date.now(), type: 'nonsurg', ptName: ptEl.value.trim(),
    doctor: document.getElementById('ns-dr').value,
    treatType: document.getElementById('ns-type').value,
    site: document.getElementById('ns-site').value,
    covered: document.getElementById('ns-covered').value === 'true',
    status: 'waiting', weekCount: 1, weekMax: 5,
    date: new Date().toISOString().substring(0, 10),
  });
  document.getElementById('modal-add-nonsurg').classList.remove('open');
  notify('등록 완료', '시술이 등록되었습니다.', 'success');
  renderScreen('nonsurg');
}

// ─── 검사 의뢰 ──────────────────────────────────────────
function openAddLabModal() {
  var testOpts = ['CBC (혈구검사)', '혈당 (FBS/PP2)', 'HbA1c', '간기능 (LFT)', '신기능 (BUN/Cr)', '전해질', 'ESR/CRP', '요검사 (UA)', 'X-ray 판독', 'MRI 판독', 'CT 판독', '조직검사']
    .map(function(t){ return '<option>' + t + '</option>'; }).join('');

  openDynamicModal('modal-add-lab',
    '<div class="modal-title">🔬 검사 의뢰</div>',
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 환자명</label><input class="form-control" id="lab-pt-name" placeholder="환자명 입력"></div>' +
      '<div class="form-group"><label>* 검사 종류</label><select class="form-control" id="lab-test-name">' + testOpts + '</select></div>' +
      '<div class="form-group"><label>결과값 (즉시 결과 시 입력)</label><input class="form-control" id="lab-result" placeholder="예: 285"></div>' +
      '<div class="form-group"><label>단위</label><input class="form-control" id="lab-unit" placeholder="예: mg/dL"></div>' +
      '<div class="form-group"><label>판정</label><select class="form-control" id="lab-status"><option value="pending">대기</option><option value="normal">정상</option><option value="received">수신</option><option value="critical">위험값</option></select></div>' +
      '<div class="form-group"><label>비고</label><input class="form-control" id="lab-note" placeholder="특이사항"></div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-add-lab\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveLabOrder()">✓ 의뢰 저장</button>'
  );
}

function saveLabOrder() {
  var ptEl = document.getElementById('lab-pt-name');
  if (!ptEl || !ptEl.value.trim()) { notify('입력 오류', '환자명을 입력하세요.', 'error'); return; }
  var statusVal = document.getElementById('lab-status').value;
  var today = new Date().toISOString().substring(0, 10);
  var lab = {
    id: 'LAB-' + Date.now(), ptName: ptEl.value.trim(),
    testName: document.getElementById('lab-test-name').value,
    orderedDate: today,
    resultDate: statusVal !== 'pending' ? today : '-',
    result: document.getElementById('lab-result').value || '-',
    unit: document.getElementById('lab-unit').value || '',
    status: statusVal,
    note: document.getElementById('lab-note').value || '',
    orderedBy: SESSION.user ? SESSION.user.id : 'USR-001',
  };
  DB.labResults.push(lab);
  if (statusVal === 'critical') {
    DB.notifications.push({ id: 'NTF-' + Date.now(), type: 'lab_critical', level: 'danger',
      message: lab.ptName + ' — ' + lab.testName + ' 위험값: ' + lab.result,
      time: new Date().toISOString(), read: false });
    notify('⚠ 위험값 검출', lab.ptName + ' ' + lab.testName + ' 위험값 — 주치의 확인 필요!', 'error');
  }
  document.getElementById('modal-add-lab').classList.remove('open');
  notify('의뢰 저장', '검사 의뢰가 등록되었습니다.', 'success');
  renderScreen('lab');
}

function notifyCritical(id) {
  var r = (DB.labResults || []).find(function(x) { return x.id === id; });
  if (!r) return;
  DB.notifications.push({ id: 'NTF-' + Date.now(), type: 'lab_critical', level: 'danger',
    message: r.ptName + ' — ' + r.testName + ' 위험값: ' + r.result, time: new Date().toISOString(), read: false });
  notify('주치의 알림 발송', r.ptName + ' ' + r.testName + ' 위험값 — 주치의 알림 발송 완료', 'success');
}

// ─── V/S 입력 ────────────────────────────────────────────
function openNursingVSModal(bed) {
  if(bed==='all') {
    // 일괄 V/S 입력 - 모든 입원 환자 목록 표시
    var wards = DB.wardPatients||[];
    if(wards.length===0){notify('안내','입원 환자가 없습니다.','info');return;}
    openDynamicModal('modal-vs-bulk',
      '<div class="modal-title">📊 일괄 활력징후 입력</div>',
      '<div style="max-height:60vh;overflow-y:auto">' +
        wards.map(function(wp){
          var k=wp.bed.replace(/[^a-z0-9]/gi,'_');
          return '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">'+
            '<div style="font-weight:700;margin-bottom:8px">'+wp.bed+' '+wp.name+' <small style="color:var(--text-muted)">'+wp.doctor+'</small></div>'+
            '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px">'+
              '<div><label style="font-size:10px">BP(수축)</label><input class="form-control" id="bulk-bps-'+k+'" placeholder="120" style="font-size:11px"></div>'+
              '<div><label style="font-size:10px">BP(이완)</label><input class="form-control" id="bulk-bpd-'+k+'" placeholder="80" style="font-size:11px"></div>'+
              '<div><label style="font-size:10px">HR</label><input class="form-control" id="bulk-hr-'+k+'" placeholder="72" style="font-size:11px"></div>'+
              '<div><label style="font-size:10px">BT(℃)</label><input class="form-control" id="bulk-bt-'+k+'" placeholder="36.5" style="font-size:11px"></div>'+
              '<div><label style="font-size:10px">SpO₂(%)</label><input class="form-control" id="bulk-spo2-'+k+'" placeholder="98" style="font-size:11px"></div>'+
            '</div></div>';
        }).join('')+
      '</div>',
      '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-vs-bulk\').classList.remove(\'open\')">취소</button>'+
      '<button class="btn btn-primary" onclick="saveBulkVitals()">✓ 일괄 저장</button>'
    );
    return;
  }

  var wp = (DB.wardPatients || []).find(function(w) { return w.bed === bed; });
  if (!wp) return;
  openDynamicModal('modal-vs-input',
    '<div class="modal-title">' + wp.bed + ' ' + wp.name + ' — V/S 입력</div>',
    '<div class="vital-grid">' +
      '<div class="vital-item"><div class="vital-label">혈압 (mmHg)</div>' +
        '<div style="display:flex;gap:4px;justify-content:center;margin:6px 0">' +
          '<input id="vs-bp-s" class="form-control" style="width:52px;text-align:center" placeholder="120">' +
          '<span style="align-self:center">/</span>' +
          '<input id="vs-bp-d" class="form-control" style="width:52px;text-align:center" placeholder="80">' +
        '</div></div>' +
      '<div class="vital-item"><div class="vital-label">맥박 (bpm)</div><input id="vs-hr" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="72"></div>' +
      '<div class="vital-item"><div class="vital-label">체온 (°C)</div><input id="vs-bt" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="36.5"></div>' +
      '<div class="vital-item"><div class="vital-label">SpO₂ (%)</div><input id="vs-spo2" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="98"></div>' +
      '<div class="vital-item"><div class="vital-label">통증 (VAS)</div><input id="vs-vas" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="3/10"></div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:12px"><label>특이사항</label>' +
      '<textarea id="vs-note" class="form-control" style="min-height:60px" placeholder="특이사항 입력"></textarea></div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-vs-input\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveVitalSigns(\'' + bed.replace(/'/g, "\\'") + '\')">✓ 저장</button>'
  );
  document.getElementById('modal-vs-input').classList.add('open');
}

function saveBulkVitals() {
  var wards = DB.wardPatients||[];
  var saved=0, alerts=0;
  var now = new Date();
  var timeStr = ('0'+now.getHours()).slice(-2)+':'+('0'+now.getMinutes()).slice(-2);
  wards.forEach(function(wp){
    var k=wp.bed.replace(/[^a-z0-9]/gi,'_');
    var bpS=(document.getElementById('bulk-bps-'+k)||{}).value||'';
    var bpD=(document.getElementById('bulk-bpd-'+k)||{}).value||'';
    if(!bpS) return; // 입력 없으면 스킵
    wp.vitals = {
      bp:bpS+'/'+bpD, hr:(document.getElementById('bulk-hr-'+k)||{}).value||'-',
      bt:(document.getElementById('bulk-bt-'+k)||{}).value||'-',
      spo2:((document.getElementById('bulk-spo2-'+k)||{}).value||'98')+'%',
      vas:'-', time:timeStr, recordedBy:SESSION.user?SESSION.user.name:'-',
    };
    saved++;
    if(parseInt(bpS)>160||parseInt(bpS)<90) {
      alerts++;
      DB.notifications.push({id:'NTF-'+Date.now()+Math.random(),type:'vital_alert',level:'danger',
        message:wp.bed+' '+wp.name+' — 혈압 '+bpS+'/'+bpD+' 이상 (주치의 확인 필요)',
        time:now.toISOString(),read:false});
    }
  });
  document.getElementById('modal-vs-bulk').classList.remove('open');
  updateNotifBadge();
  notify('일괄 저장',saved+'명 활력징후 저장 완료.'+(alerts>0?' ⚠ 이상 '+alerts+'건':' 모두 정상'),'success');
  renderScreen('nursing');
}

function saveVitalSigns(bed) {
  var wp = (DB.wardPatients || []).find(function(w) { return w.bed === bed; });
  if (!wp) return;
  var bpS = (document.getElementById('vs-bp-s') || {}).value || '';
  var bpD = (document.getElementById('vs-bp-d') || {}).value || '';
  var now = new Date();
  wp.vitals = {
    bp: bpS && bpD ? bpS + '/' + bpD : (wp.vitals ? wp.vitals.bp : '-'),
    hr: (document.getElementById('vs-hr') || {}).value || (wp.vitals ? wp.vitals.hr : '-'),
    bt: (document.getElementById('vs-bt') || {}).value || (wp.vitals ? wp.vitals.bt : '-'),
    spo2: ((document.getElementById('vs-spo2') || {}).value || (wp.vitals ? wp.vitals.spo2 : '98')) + '%',
    vas: (document.getElementById('vs-vas') || {}).value || (wp.vitals ? wp.vitals.vas : '-'),
    time: now.getHours() + ':' + ('0' + now.getMinutes()).slice(-2),
    note: (document.getElementById('vs-note') || {}).value || '',
    recordedBy: SESSION.user ? SESSION.user.name : '-',
  };
  if (parseInt(bpS) > 160) {
    DB.notifications.push({ id: 'NTF-' + Date.now(), type: 'vital_alert', level: 'danger',
      message: wp.bed + ' ' + wp.name + ' — 혈압 ' + bpS + '/' + bpD + ' 이상 (주치의 확인 필요)',
      time: new Date().toISOString(), read: false });
    notify('⚠ 활력징후 이상', wp.bed + ' ' + wp.name + ': 혈압 ' + bpS + '/' + bpD + ' — 주치의 즉시 보고!', 'error');
  }
  DB.auditLog.push({ time: new Date().toISOString(), action: 'VITALS_RECORDED',
    user: SESSION.user ? SESSION.user.username : '-', bed: bed, bp: bpS + '/' + bpD });
  var overlay = document.getElementById('modal-vs-input');
  if (overlay) overlay.classList.remove('open');
  notify('저장 완료', wp.bed + ' ' + wp.name + ' 활력징후가 기록되었습니다.', 'success');
  renderScreen('nursing');
}

// ─── 동의서 발행 ─────────────────────────────────────────
function saveConsentIssue() {
  var ptEl   = document.getElementById('consent-pt-name');
  var typeEl = document.getElementById('consent-type');
  if (!ptEl || !ptEl.value.trim()) { notify('입력 오류', '환자명을 입력하세요.', 'error'); return; }
  if (!typeEl || !typeEl.value)    { notify('입력 오류', '동의서 종류를 선택하세요.', 'error'); return; }
  var today   = new Date().toISOString().substring(0, 10);
  var expDate = new Date(Date.now() + 30 * 86400000).toISOString().substring(0, 10);
  DB.consents.push({
    id: 'CNS-' + Date.now(), ptName: ptEl.value.trim(), type: typeEl.value,
    issuedDate: today, signedDate: '-', expDate: expDate, signer: '-', status: 'pending',
    issuedBy: SESSION.user ? SESSION.user.id : 'USR-001',
    issuedByName: SESSION.user ? SESSION.user.name : '-',
  });
  DB.auditLog.push({ time: new Date().toISOString(), action: 'CONSENT_ISSUED',
    user: SESSION.user ? SESSION.user.username : '-', ptName: ptEl.value.trim(), type: typeEl.value });
  closeModal('modal-consent');
  notify('동의서 발행 완료', ptEl.value.trim() + ' ' + typeEl.value + ' 발행 완료', 'success');
  renderScreen('consent');
}

function signConsent(id) {
  var con = (DB.consents || []).find(function(x) { return x.id === id; });
  if (!con) return;
  con.status = 'signed';
  con.signedDate = new Date().toISOString().substring(0, 10);
  con.signer = '본인';
  DB.auditLog.push({ time: new Date().toISOString(), action: 'CONSENT_SIGNED',
    user: SESSION.user ? SESSION.user.username : '-', consentId: id, ptName: con.ptName });
  renderScreen('consent');
  notify('서명 완료', con.ptName + ' ' + con.type + ' 서명 처리되었습니다.', 'success');
}

function renderConsentPreview(type) {
  var bodyEl = document.getElementById('consent-preview-body');
  if (!bodyEl) return;
  var bodies = {
    '수술 동의서': '본인은 담당 의사로부터 수술의 목적, 방법, 예상 결과 및 합병증에 대해 충분한 설명을 들었으며, 이를 이해하고 수술 시행에 동의합니다.',
    '마취 동의서': '전신마취 또는 부위마취 시행에 따른 위험성 및 합병증에 대해 설명을 들었으며 이에 동의합니다.',
    '수혈 동의서': '수술 중 또는 수술 후 수혈이 필요할 수 있음을 설명 들었으며, 수혈에 동의합니다.',
    '입원 동의서': '입원 치료의 목적, 입원 생활 규칙, 비용 처리 방법에 대해 설명을 들었으며 입원에 동의합니다.',
    '개인정보 제공 동의서': '진료 목적의 개인정보 수집·이용·제공에 동의합니다. (의료법 제21조)',
    '사진·영상 활용 동의서': '교육·연구 목적의 사진·영상 촬영 및 활용에 동의합니다.',
    '연명의료 결정 동의서': '연명의료결정법에 따른 연명의료 시행 여부를 사전에 결정합니다.',
  };
  bodyEl.innerHTML = (bodies[type] || '동의서 내용') +
    '<br><br><strong>담당의:</strong> ' + (SESSION.user ? SESSION.user.name : '-') +
    '<br><strong>발행일:</strong> ' + new Date().toLocaleDateString('ko-KR') +
    '<br><strong>유효기간:</strong> 발행일로부터 30일';
}


// ─── MODALS ────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('open');
  // 접수 모달 열릴 때 현재 로그인 의사의 진료과/담당의 자동 선택
  if(id === 'modal-reception' && SESSION.user) {
    var role = SESSION.user.role;
    var isDoc = role.startsWith('doctor_') || role === 'hospital_director';
    if(isDoc) {
      setTimeout(function(){
        var deptSel = document.getElementById('pt-dept');
        var docSel  = document.getElementById('pt-doctor');
        if(deptSel && SESSION.user.dept) {
          Array.from(deptSel.options).forEach(function(o){
            o.selected = (o.value === SESSION.user.dept);
          });
          // 담당의 목록 업데이트
          updateDoctorList(SESSION.user.dept);
          // 본인 자동 선택
          setTimeout(function(){
            if(docSel) {
              Array.from(docSel.options).forEach(function(o){
                o.selected = (o.value === SESSION.user.name || o.text.startsWith(SESSION.user.name));
              });
            }
          }, 30);
        }
      }, 10);
    }
  }
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if(e.target === m) m.classList.remove('open'); });
});

// ─── NOTIFICATIONS ─────────────────────────────────────
function notify(title, msg, type='info') {
  const icons = {success:'✅',error:'🚫',warning:'⚠',info:'ℹ'};
  const cont = document.getElementById('notif-container');
  const el = document.createElement('div');
  el.className = `notif-item ${type}`;
  el.innerHTML = `<span style="font-size:18px">${icons[type]||'ℹ'}</span>
  <div class="notif-text"><div class="notif-title">${title}</div><div class="notif-sub">${msg}</div></div>
  <button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px;padding:0 4px;align-self:flex-start">✕</button>`;
  cont.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── CLOCK ─────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const d = now.toLocaleDateString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit'});
  const t = now.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const el = document.getElementById('clock');
  if(el) el.textContent = `${d} ${t}`;
}
setInterval(updateClock, 1000);
updateClock();

// ─── INIT SCREENS ──────────────────────────────────────
Object.keys(screens).forEach(name => {
  const el = document.getElementById('screen-' + name);
  if(!el) return;
});

function renderOR(el) {
  var sched  = DB.surgeries || [];
  var today  = new Date().toISOString().substring(0,10);
  var done   = sched.filter(function(s){ return s.status === 'completed'; });
  var active = sched.filter(function(s){ return s.status === 'in_progress'; });
  var wait   = sched.filter(function(s){ return s.status === 'scheduled' || s.status === 'prep'; });

  // ── 수술 스케줄 행 ──────────────────────────────────
  function schedRow(s) {
    var lbl = {completed:'완료', in_progress:'🔴 진행중', prep:'준비중', scheduled:'대기'}[s.status]||s.status;
    var bdg = s.status==='completed'?'badge-done':s.status==='in_progress'?'badge-progress':'badge-waiting';
    var elapsed = '';
    if(s.status==='in_progress' && s.startTime) {
      var mins = Math.round((Date.now()-new Date(s.startTime).getTime())/60000);
      elapsed = ' (' + Math.floor(mins/60) + 'h' + ('0'+mins%60).slice(-2) + 'm)';
    }
    return '<tr' + (s.status==='in_progress'?' style="background:#fff8f0"':'') + '>' +
      '<td style="font-family:var(--mono);font-weight:600">' + (s.time||'-') + '</td>' +
      '<td><strong>' + (s.ptName||'-') + '</strong></td>' +
      '<td style="font-size:11px">' + (s.opName||'-') + '</td>' +
      '<td style="font-size:11px">' + (s.surgeon||'-') + '</td>' +
      '<td>' + (s.room||'-') + '</td>' +
      '<td style="font-size:11px">' + (s.anesthesia||'-') + '</td>' +
      '<td><span class="badge ' + bdg + '">' + lbl + elapsed + '</span></td>' +
      '<td>' +
        '<div class="btn-group">' +
          (s.status!=='completed'?'<button class="btn btn-sm btn-primary" onclick="openSurgeryDetail(\'' + s.id + '\')">▶ 수술관리</button>':'') +
          '<button class="btn btn-sm btn-ghost" onclick="openSurgeryRecord(\'' + s.id + '\')">기록</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  // ── 완료 기록 행 ─────────────────────────────────────
  function histRow(s) {
    return '<tr>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (s.date||'-') + '</td>' +
      '<td><strong>' + s.ptName + '</strong></td>' +
      '<td style="font-size:11px">' + s.opName + '</td>' +
      '<td style="font-size:11px">' + (s.surgeon||'-') + '</td>' +
      '<td style="font-family:var(--mono)">' + (s.duration||'-') + '</td>' +
      '<td style="font-size:11px">' + (s.anesthesia||'-') + '</td>' +
      '<td style="font-family:var(--mono)">' + (s.bloodLoss||'-') + '</td>' +
      '<td>' +
        '<span style="color:' + (s.complication&&s.complication!=='없음'?'var(--danger)':'var(--success)') + ';font-size:11px">' +
          (s.complication&&s.complication!=='없음'?'⚠ ':' ✓ ') + (s.complication||'없음') +
        '</span>' +
      '</td>' +
      '<td><button class="btn btn-sm btn-ghost" onclick="openSurgeryRecord(\'' + s.id + '\')">기록보기</button></td>' +
    '</tr>';
  }

  var schedHtml = sched.length===0
    ? '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">오늘 수술 없음 — "+ 수술 등록" 버튼으로 추가</td></tr>'
    : sched.map(schedRow).join('');
  var histHtml  = done.length===0
    ? '<tr><td colspan="9" style="text-align:center;padding:14px;color:var(--text-muted)">완료된 수술 없음</td></tr>'
    : done.map(histRow).join('');

  // ── 진행중 수술 상세 패널 ────────────────────────────
  var activePanelHtml = '';
  if(active.length > 0) {
    var as = active[0];
    var anRec = (DB.anesthesiaRecords||[]).find(function(r){return r.surgId===as.id;}) || null;
    var matUsed = (DB.stockMovements||[]).filter(function(m){return m.surgId===as.id && m.type==='use';});
    var matCost = matUsed.reduce(function(a,m){return a+(m.qty*(m.price||0));}, 0);
    var vitalsHtml = anRec && anRec.vitals && anRec.vitals.length>0
      ? anRec.vitals.slice(-5).map(function(v){
          return '<tr><td style="font-family:var(--mono);font-size:10px">' + v.time + '</td>' +
            '<td style="font-family:var(--mono)">' + (v.bp||'-') + '</td>' +
            '<td>' + (v.hr||'-') + '</td>' +
            '<td>' + (v.spo2||'-') + '</td>' +
            '<td>' + (v.etco2||'-') + '</td>' +
            '<td style="font-size:10px">' + (v.note||'-') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="6" style="text-align:center;padding:10px;color:var(--text-muted)">활력징후 기록 없음 — "V/S 입력" 버튼 사용</td></tr>';
    var matHtml = matUsed.length>0
      ? matUsed.map(function(m){
          return '<tr><td style="font-size:11px">' + m.name + '</td><td>' + m.qty + ' ' + (m.unit||'') + '</td>' +
            '<td style="font-family:var(--mono)">' + ((m.qty*(m.price||0)).toLocaleString()) + '원</td></tr>';
        }).join('')
      : '<tr><td colspan="3" style="text-align:center;padding:10px;color:var(--text-muted)">사용 재료 없음</td></tr>';
    var elapsed2 = '-';
    if(as.startTime) {
      var mins2 = Math.round((Date.now()-new Date(as.startTime).getTime())/60000);
      elapsed2 = Math.floor(mins2/60) + 'h ' + ('0'+mins2%60).slice(-2) + 'm';
    }

    activePanelHtml =
      '<div style="background:#fff8f0;border:2px solid #ff9800;border-radius:10px;padding:16px;margin-bottom:16px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
          '<div>' +
            '<span style="font-size:11px;font-weight:700;color:#e65100;letter-spacing:1px;text-transform:uppercase">🔴 수술 진행중</span>' +
            '<div style="font-size:15px;font-weight:800;margin-top:4px">' + as.ptName + ' — ' + as.opName + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + (as.surgeon||'-') + ' | ' + (as.room||'-') + ' | 경과: ' + elapsed2 + '</div>' +
          '</div>' +
          '<div class="btn-group">' +
            '<button class="btn btn-outline" onclick="openAnesthesiaVSModal(\'' + as.id + '\')">💉 V/S 입력</button>' +
            '<button class="btn btn-outline" onclick="openSurgeryMaterialModal(\'' + as.id + '\')">📦 재료 사용</button>' +
            '<button class="btn btn-warning" onclick="openSurgeryEventModal(\'' + as.id + '\')">⚠ 이벤트 기록</button>' +
            '<button class="btn btn-primary" onclick="completeSurgery(\'' + as.id + '\')">✓ 수술 완료</button>' +
          '</div>' +
        '</div>' +
        '<div class="grid-2" style="gap:12px">' +
          '<div>' +
            '<div style="font-size:11px;font-weight:700;margin-bottom:6px">마취 중 활력징후 (최근 5회)</div>' +
            '<table style="font-size:11px"><thead><tr style="background:#f5f7fa">' +
              '<th>시간</th><th>BP</th><th>HR</th><th>SpO₂</th><th>EtCO₂</th><th>비고</th>' +
            '</tr></thead><tbody>' + vitalsHtml + '</tbody></table>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:11px;font-weight:700;margin-bottom:6px">사용 재료 (₩' + matCost.toLocaleString() + ')</div>' +
            '<table style="font-size:11px"><thead><tr style="background:#f5f7fa">' +
              '<th>재료명</th><th>사용량</th><th>금액</th>' +
            '</tr></thead><tbody>' + matHtml + '</tbody></table>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">🔪 수술실 현황 — ' + today + '</div>' +
      '<div class="btn-group">' +
        '<button class="btn btn-outline" onclick="openSurgeryChecklist()">✅ 안전 체크리스트</button>' +
        '<button class="btn btn-outline" onclick="openModal(\'modal-consent\')">📜 동의서</button>' +
        '<button class="btn btn-primary" onclick="openAddSurgeryModal()">+ 수술 등록</button>' +
      '</div>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">오늘 수술 예정</div><div class="stat-value">' + sched.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">완료</div><div class="stat-value">' + done.length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">진행중</div><div class="stat-value">' + active.length + '</div>' + (active.length>0?'<div class="stat-sub">' + (active[0]?active[0].opName.substring(0,15)+'...':'') + '</div>':'') + '</div>' +
      '<div class="stat-card red"><div class="stat-label">대기</div><div class="stat-value">' + wait.length + '</div></div>' +
    '</div>' +
    activePanelHtml +
    '<div class="card" style="margin-bottom:14px">' +
      '<div class="card-header">' +
        '<div class="card-title">📋 수술 스케줄</div>' +
      '</div>' +
      '<div class="tbl-wrap"><table>' +
        '<thead><tr><th>시간</th><th>환자</th><th>수술명</th><th>집도의</th><th>OR</th><th>마취</th><th>상태</th><th>관리</th></tr></thead>' +
        '<tbody>' + schedHtml + '</tbody>' +
      '</table></div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">📊 수술 완료 기록</div></div>' +
      '<div class="tbl-wrap"><table>' +
        '<thead><tr><th>날짜</th><th>환자명</th><th>수술명</th><th>집도의</th><th>수술시간</th><th>마취</th><th>출혈량</th><th>합병증</th><th>관리</th></tr></thead>' +
        '<tbody>' + histHtml + '</tbody>' +
      '</table></div>' +
    '</div>';
}

// ─── 수술 세부 관리 함수들 ────────────────────────────────
function openSurgeryDetail(id) {
  var s = (DB.surgeries||[]).find(function(x){return x.id===id;});
  if(!s) return;
  // 진행 상태 변경
  var next = {scheduled:'prep', prep:'in_progress'}[s.status];
  if(next) {
    if(!confirm((next==='prep'?'준비 시작':'수술 시작') + '으로 상태를 변경하시겠습니까?')) return;
    s.status = next;
    if(next==='in_progress') {
      s.startTime = new Date().toISOString();
      // 마취 기록 생성
      if(!(DB.anesthesiaRecords||[]).find(function(r){return r.surgId===id;})) {
        DB.anesthesiaRecords = DB.anesthesiaRecords||[];
        DB.anesthesiaRecords.push({
          surgId: id, type: s.anesthesia||'전신마취', drugs:[], vitals:[], events:[],
          anesthesiologist: '허철회 원장', startTime: new Date().toISOString(), endTime:null,
        });
      }
      notify('수술 시작', s.ptName + ' ' + s.opName + ' 수술을 시작합니다.', 'success');
    } else {
      notify('준비중', s.ptName + ' 수술 준비를 시작합니다.', 'info');
    }
    DB.auditLog.push({time:new Date().toISOString(),action:'SURGERY_STATUS_CHANGED',user:SESSION.user?SESSION.user.username:'-',surgId:id,status:next});
    renderScreen('or');
  } else if(s.status==='in_progress') {
    completeSurgery(id);
  }
}

function openSurgeryChecklist() {
  openModal('modal-surgery-checklist');
}


function completeSurgery(id) {
  var s = (DB.surgeries||[]).find(function(x){return x.id===id;});
  if(!s) return;
  var bl = prompt('출혈량 (mL):', '150');
  if(bl===null) return;
  var comp = prompt('합병증 (없으면 "없음"):', '없음');
  if(comp===null) return;
  s.status = 'completed';
  s.endTime = new Date().toISOString();
  if(s.startTime) {
    var mins = Math.round((new Date(s.endTime)-new Date(s.startTime))/60000);
    s.duration = Math.floor(mins/60) + 'h ' + ('0'+mins%60).slice(-2) + 'm';
  }
  s.bloodLoss = bl + 'mL';
  s.complication = comp||'없음';
  // 마취 기록 종료
  var anRec = (DB.anesthesiaRecords||[]).find(function(r){return r.surgId===id;});
  if(anRec) anRec.endTime = new Date().toISOString();
  DB.auditLog.push({time:new Date().toISOString(),action:'SURGERY_COMPLETED',user:SESSION.user?SESSION.user.username:'-',surgId:id,duration:s.duration,bloodLoss:s.bloodLoss});
  notify('수술 완료', s.ptName + ' ' + s.opName + ' — ' + s.duration + ', 출혈 ' + s.bloodLoss, 'success');
  renderScreen('or');
}

function openAnesthesiaVSModal(surgId) {
  var s = (DB.surgeries||[]).find(function(x){return x.id===surgId;});
  if(!s) return;
  openDynamicModal('modal-an-vs',
    '<div class="modal-title">💉 마취 중 활력징후 입력 — ' + s.ptName + '</div>',
    '<div class="grid-3">' +
      '<div class="vital-item"><div class="vital-label">혈압 (BP)</div>' +
        '<div style="display:flex;gap:4px;justify-content:center;margin:6px 0">' +
          '<input id="an-bp-s" class="form-control" style="width:52px;text-align:center" placeholder="120">' +
          '<span style="align-self:center">/</span>' +
          '<input id="an-bp-d" class="form-control" style="width:52px;text-align:center" placeholder="80">' +
        '</div></div>' +
      '<div class="vital-item"><div class="vital-label">맥박 (HR)</div><input id="an-hr" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="72"></div>' +
      '<div class="vital-item"><div class="vital-label">SpO₂ (%)</div><input id="an-spo2" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="99"></div>' +
      '<div class="vital-item"><div class="vital-label">EtCO₂</div><input id="an-etco2" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="35"></div>' +
      '<div class="vital-item"><div class="vital-label">체온 (°C)</div><input id="an-temp" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="36.5"></div>' +
      '<div class="vital-item"><div class="vital-label">MAP</div><input id="an-map" class="form-control" style="width:70px;margin:6px auto;display:block;text-align:center" placeholder="80"></div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:8px"><label>비고</label><input id="an-note" class="form-control" placeholder="특이사항 (예: 출혈 증가, 혈압 저하)"></div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-an-vs\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveAnesthesiaVS(\'' + surgId + '\')">✓ 기록 저장</button>'
  );
}

function saveAnesthesiaVS(surgId) {
  var anRec = (DB.anesthesiaRecords||[]).find(function(r){return r.surgId===surgId;});
  if(!anRec) { notify('오류','마취 기록을 찾을 수 없습니다.','error'); return; }
  var now = new Date();
  var timeStr = ('0'+now.getHours()).slice(-2)+':'+('0'+now.getMinutes()).slice(-2);
  var bpS = document.getElementById('an-bp-s').value;
  var bpD = document.getElementById('an-bp-d').value;
  anRec.vitals.push({
    time: timeStr,
    bp: bpS && bpD ? bpS+'/'+bpD : '-',
    hr: document.getElementById('an-hr').value||'-',
    spo2: (document.getElementById('an-spo2').value||'-')+'%',
    etco2: document.getElementById('an-etco2').value||'-',
    temp: document.getElementById('an-temp').value||'-',
    map: document.getElementById('an-map').value||'-',
    note: document.getElementById('an-note').value||'',
  });
  // 이상 체크
  if(parseInt(bpS)<90||parseInt(bpS)>180) {
    DB.notifications.push({id:'NTF-'+Date.now(),type:'vital_alert',level:'danger',
      message:'수술중 혈압 이상: '+bpS+'/'+bpD+' — 마취과 확인 필요',time:new Date().toISOString(),read:false});
    notify('⚠ 혈압 이상','수술 중 혈압 이상 감지: '+bpS+'/'+bpD,'error');
  }
  document.getElementById('modal-an-vs').classList.remove('open');
  notify('V/S 기록','활력징후가 기록되었습니다.','success');
  renderScreen('or');
}

function openSurgeryMaterialModal(surgId) {
  var s = (DB.surgeries||[]).find(function(x){return x.id===surgId;});
  if(!s) return;
  var surgMats = DB.inventory.filter(function(i){ return i.category==='수술재료'||i.category==='소모품'; });
  var opts = surgMats.map(function(i){
    return '<option value="' + i.code + '" data-price="' + i.price + '" data-unit="' + i.unit + '" data-name="' + i.name + '">' +
      i.name + ' (재고: ' + i.qty + ' ' + i.unit + ')' +
    '</option>';
  }).join('');
  // 이미 사용한 재료 목록
  var usedMats = (DB.stockMovements||[]).filter(function(m){return m.surgId===surgId&&m.type==='use';});
  var usedHtml = usedMats.length===0
    ? '<div style="text-align:center;padding:8px;color:var(--text-muted);font-size:11px">아직 사용 기록 없음</div>'
    : usedMats.map(function(m){
        return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:11px;border-bottom:1px solid #f5f5f5">' +
          '<span>' + m.name + '</span><span style="color:var(--text-muted)">' + m.qty + ' ' + (m.unit||'') + ' | ₩' + (m.qty*(m.price||0)).toLocaleString() + '</span>' +
        '</div>';
      }).join('');

  openDynamicModal('modal-surg-mat',
    '<div class="modal-title">📦 수술 재료 사용 등록 — ' + s.ptName + '</div>',
    '<div class="form-group"><label>* 재료 선택</label>' +
      '<select class="form-control" id="mat-code">' + opts + '</select></div>' +
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 사용 수량</label><input class="form-control" type="number" id="mat-qty" value="1" min="1"></div>' +
      '<div class="form-group"><label>비고</label><input class="form-control" id="mat-note" placeholder="예: 추가 사용"></div>' +
    '</div>' +
    '<div style="border-top:1px solid var(--border);margin-top:12px;padding-top:10px">' +
      '<div style="font-size:11px;font-weight:700;margin-bottom:6px">이미 사용된 재료</div>' +
      usedHtml +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-surg-mat\').classList.remove(\'open\')">닫기</button>' +
    '<button class="btn btn-primary" onclick="saveSurgeryMaterial(\'' + surgId + '\')">✓ 사용 등록</button>'
  );
}

function saveSurgeryMaterial(surgId) {
  var codeEl = document.getElementById('mat-code');
  var qtyEl  = document.getElementById('mat-qty');
  if(!codeEl||!qtyEl) return;
  var code = codeEl.value;
  var qty  = parseInt(qtyEl.value)||1;
  var inv  = DB.inventory.find(function(i){return i.code===code;});
  if(!inv) { notify('오류','재료를 찾을 수 없습니다.','error'); return; }
  if(inv.qty < qty) { notify('재고 부족','재고가 부족합니다 (현재: '+inv.qty+' '+inv.unit+')','error'); return; }
  // 재고 차감
  inv.qty -= qty;
  // 이동 기록
  DB.stockMovements = DB.stockMovements||[];
  DB.stockMovements.push({
    id:'SM-'+Date.now(), code:code, name:inv.name, type:'use', qty:qty,
    unit:inv.unit, price:inv.price, reason:'수술 사용', surgId:surgId,
    createdAt:new Date().toISOString(), createdBy:SESSION.user?SESSION.user.id:'',
    note: document.getElementById('mat-note').value||'',
  });
  DB.auditLog.push({time:new Date().toISOString(),action:'STOCK_USE',user:SESSION.user?SESSION.user.username:'-',code:code,qty:qty,surgId:surgId});
  document.getElementById('modal-surg-mat').classList.remove('open');
  notify('재료 등록',''+inv.name+' '+qty+inv.unit+' 사용 기록 완료 (재고: '+inv.qty+inv.unit+')','success');
  renderScreen('or');
}

function openSurgeryEventModal(surgId) {
  var s = (DB.surgeries||[]).find(function(x){return x.id===surgId;});
  if(!s) return;
  openDynamicModal('modal-surg-event',
    '<div class="modal-title">⚠ 수술 중 이벤트 기록 — ' + s.ptName + '</div>',
    '<div class="form-group"><label>* 이벤트 유형</label>' +
      '<select class="form-control" id="ev-type">' +
        '<option>출혈 증가</option><option>혈압 변동</option><option>심박 이상</option>' +
        '<option>기도 문제</option><option>약물 반응</option><option>수술 계획 변경</option>' +
        '<option>추가 재료 사용</option><option>기타</option>' +
      '</select></div>' +
    '<div class="form-group"><label>* 상세 내용</label><textarea class="form-control" id="ev-detail" style="min-height:80px" placeholder="상세 내용 입력"></textarea></div>' +
    '<div class="form-group"><label>처치 내용</label><input class="form-control" id="ev-action" placeholder="취한 조치"></div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-surg-event\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-warning" onclick="saveSurgeryEvent(\'' + surgId + '\')">✓ 이벤트 기록</button>'
  );
}

function saveSurgeryEvent(surgId) {
  var anRec = (DB.anesthesiaRecords||[]).find(function(r){return r.surgId===surgId;});
  var now = new Date();
  var evt = {
    time: ('0'+now.getHours()).slice(-2)+':'+('0'+now.getMinutes()).slice(-2),
    type: document.getElementById('ev-type').value,
    detail: document.getElementById('ev-detail').value,
    action: document.getElementById('ev-action').value,
  };
  if(anRec) anRec.events.push(evt);
  document.getElementById('modal-surg-event').classList.remove('open');
  notify('이벤트 기록','수술 중 이벤트가 기록되었습니다.','info');
  renderScreen('or');
}

function openSurgeryRecord(id) {
  var s = (DB.surgeries||[]).find(function(x){return x.id===id;});
  if(!s) { notify('알림','수술 기록을 찾을 수 없습니다.','info'); return; }
  var anRec = (DB.anesthesiaRecords||[]).find(function(r){return r.surgId===id;});
  var matUsed = (DB.stockMovements||[]).filter(function(m){return m.surgId===id&&m.type==='use';});
  var matTotal = matUsed.reduce(function(a,m){return a+(m.qty*(m.price||0));},0);

  var vsHtml = anRec&&anRec.vitals&&anRec.vitals.length>0
    ? anRec.vitals.map(function(v){return '<tr><td>'+v.time+'</td><td>'+v.bp+'</td><td>'+v.hr+'</td><td>'+v.spo2+'</td><td>'+(v.etco2||'-')+'</td><td style="font-size:10px">'+(v.note||'-')+'</td></tr>';}).join('')
    : '<tr><td colspan="6" style="text-align:center;padding:10px;color:var(--text-muted)">활력징후 기록 없음</td></tr>';
  var evHtml = anRec&&anRec.events&&anRec.events.length>0
    ? anRec.events.map(function(e){return '<tr><td>'+e.time+'</td><td><strong>'+e.type+'</strong></td><td style="font-size:11px">'+e.detail+'</td><td style="font-size:11px">'+e.action+'</td></tr>';}).join('')
    : '<tr><td colspan="4" style="text-align:center;padding:10px;color:var(--text-muted)">이벤트 없음</td></tr>';
  var matHtml2 = matUsed.length>0
    ? matUsed.map(function(m){return '<tr><td style="font-size:11px">'+m.name+'</td><td>'+m.qty+' '+(m.unit||'')+'</td><td style="font-family:var(--mono)">₩'+(m.qty*(m.price||0)).toLocaleString()+'</td><td style="font-size:10px">'+(m.note||'-')+'</td></tr>';}).join()+
      '<tr style="background:#f5f7fa"><td colspan="2" style="text-align:right;font-weight:700">재료비 합계</td><td style="font-family:var(--mono);font-weight:800;color:var(--primary)">₩'+matTotal.toLocaleString()+'</td><td></td></tr>'
    : '<tr><td colspan="4" style="text-align:center;padding:10px;color:var(--text-muted)">사용 재료 없음</td></tr>';

  openDynamicModal('modal-surg-record',
    '<div class="modal-title">📋 수술 기록 — ' + s.ptName + '</div>',
    '<div style="background:#f8fafd;border-radius:8px;padding:12px;margin-bottom:12px">' +
      '<div class="grid-2" style="font-size:12px">' +
        '<div><strong>환자:</strong> '+s.ptName+'</div>' +
        '<div><strong>수술명:</strong> '+s.opName+'</div>' +
        '<div><strong>집도의:</strong> '+(s.surgeon||'-')+'</div>' +
        '<div><strong>마취:</strong> '+(s.anesthesia||'-')+'</div>' +
        '<div><strong>수술시간:</strong> '+(s.duration||'진행중')+'</div>' +
        '<div><strong>출혈량:</strong> '+(s.bloodLoss||'-')+'</div>' +
        '<div><strong>합병증:</strong> '+(s.complication||'-')+'</div>' +
        '<div><strong>상태:</strong> '+(s.status||'-')+'</div>' +
      '</div>' +
    '</div>' +
    '<div class="tabs" style="margin-bottom:10px">' +
      '<div class="tab active" onclick="switchRecordTab(\'vs\',this)">마취 V/S</div>' +
      '<div class="tab" onclick="switchRecordTab(\'ev\',this)">수술 이벤트</div>' +
      '<div class="tab" onclick="switchRecordTab(\'mat\',this)">사용 재료</div>' +
    '</div>' +
    '<div id="rec-tab-vs">' +
      '<table style="font-size:11px"><thead><tr style="background:#f5f7fa"><th>시간</th><th>BP</th><th>HR</th><th>SpO₂</th><th>EtCO₂</th><th>비고</th></tr></thead>' +
      '<tbody>' + vsHtml + '</tbody></table>' +
    '</div>' +
    '<div id="rec-tab-ev" style="display:none">' +
      '<table style="font-size:11px"><thead><tr style="background:#f5f7fa"><th>시간</th><th>유형</th><th>내용</th><th>처치</th></tr></thead>' +
      '<tbody>' + evHtml + '</tbody></table>' +
    '</div>' +
    '<div id="rec-tab-mat" style="display:none">' +
      '<table style="font-size:11px"><thead><tr style="background:#f5f7fa"><th>재료명</th><th>수량</th><th>금액</th><th>비고</th></tr></thead>' +
      '<tbody>' + matHtml2 + '</tbody></table>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-surg-record\').classList.remove(\'open\')">닫기</button>' +
    '<button class="btn btn-outline" onclick="notify(\'출력\',\'수술 기록지를 출력합니다.\',\'info\')">🖨 출력</button>'
  );
}

function switchRecordTab(tab, el) {
  document.querySelectorAll('#modal-surg-record .tab').forEach(function(t){t.classList.remove('active');});
  el.classList.add('active');
  ['vs','ev','mat'].forEach(function(t){
    var el2 = document.getElementById('rec-tab-'+t);
    if(el2) el2.style.display = t===tab?'':'none';
  });
}


function renderPharmacy(el) {
  var prx     = DB.prescriptions || [];
  var waiting = prx.filter(function(p){ return p.status==='waiting'||p.status==='dur_check'; });
  var dispensing = prx.filter(function(p){ return p.status==='dispensing'; });
  var done    = prx.filter(function(p){ return p.status==='completed'; });
  var durWarn = prx.filter(function(p){ return p.durWarning; });
  // 약품 재고
  var drugs   = DB.inventory.filter(function(i){ return i.category==='약품'; });
  var drugLow = drugs.filter(function(i){ return i.qty<i.min; });

  function waitRow(r) {
    var statusCls = r.status==='dur_check'?'badge-urgent':r.status==='dispensing'?'badge-progress':'badge-waiting';
    var statusLbl = r.status==='dur_check'?'DUR확인':r.status==='dispensing'?'조제중':'대기';
    return '<tr' + (r.durWarning?' style="background:#fff8e1"':'') + '>' +
      '<td style="font-family:var(--mono);font-size:11px">' + r.id + '</td>' +
      '<td><strong>' + r.ptName + '</strong></td>' +
      '<td style="font-size:11px">' + (r.doctor||'-') + '</td>' +
      '<td>' + (r.drugCount||0) + '종</td>' +
      '<td style="font-family:var(--mono);font-size:10px">' + (r.issuedAt||'').substring(11,16) + '</td>' +
      '<td>' + (r.durWarning ?
        '<span class="badge badge-urgent" style="cursor:pointer" onclick="showDURDetail(\'' + r.id + '\')">⚠ DUR</span>' :
        '<span style="color:var(--success);font-size:11px">✓ 이상없음</span>') + '</td>' +
      '<td><span class="badge ' + statusCls + '">' + statusLbl + '</span></td>' +
      '<td>' +
        '<div class="btn-group">' +
          '<button class="btn btn-sm btn-outline" onclick="openPrescriptionDetail(\'' + r.id + '\')">처방 확인</button>' +
          (r.status==='waiting' && r.durWarning ? '<button class="btn btn-sm btn-warning" onclick="confirmDUR(\'' + r.id + '\')">DUR 확인</button>' :
           r.status==='waiting' && !r.durWarning ? '<button class="btn btn-sm btn-info" onclick="startDispense(\'' + r.id + '\')">조제 시작</button>' :
           r.status==='dispensing' ? '<button class="btn btn-sm btn-primary" onclick="completeDispense(\'' + r.id + '\')">조제 완료</button>' : '') +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  function doneRow(r) {
    return '<tr>' +
      '<td style="font-family:var(--mono);font-size:11px">' + r.id + '</td>' +
      '<td><strong>' + r.ptName + '</strong></td>' +
      '<td style="font-size:11px">' + (r.doctor||'-') + '</td>' +
      '<td>' + (r.drugCount||0) + '종</td>' +
      '<td style="font-family:var(--mono);font-size:10px">' + (r.completedAt||'').substring(11,16) + '</td>' +
      '<td><span class="badge badge-done">완료</span></td>' +
    '</tr>';
  }

  var waitHtml = waiting.length===0
    ? '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">조제 대기 없음 — EMR에서 처방 저장 시 자동 연동됩니다</td></tr>'
    : waiting.map(waitRow).join('');

  var durHtml = durWarn.length===0
    ? '<div style="text-align:center;padding:14px;color:var(--success);font-size:12px">✓ 현재 DUR 경고 없음</div>'
    : durWarn.map(function(r){
        return '<div class="claim-warn ' + (r.durLevel==='error'?'error':'warning') + '" style="margin-bottom:6px">' +
          '<span class="claim-icon">' + (r.durLevel==='error'?'🚫':'⚠') + '</span>' +
          '<div><strong>' + r.ptName + '</strong> — ' + (r.durType||'') + '<br>' +
          '<span style="font-size:11px">' + (r.durMessage||'') + '</span></div>' +
        '</div>';
      }).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">💊 약제실 — 조제 현황</div>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">조제 대기</div><div class="stat-value">' + waiting.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">오늘 완료</div><div class="stat-value">' + done.length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">DUR 경고</div><div class="stat-value">' + durWarn.length + '</div>' + (durWarn.length>0?'<div class="stat-sub">즉시 확인 필요</div>':'') + '</div>' +
      '<div class="stat-card red"><div class="stat-label">약품 재고 부족</div><div class="stat-value">' + drugLow.length + '</div>' + (drugLow.length>0?'<div class="stat-sub" style="cursor:pointer" onclick="renderScreen(\'inventory\')">재고 확인 →</div>':'') + '</div>' +
    '</div>' +
    (drugLow.length>0?
      '<div style="background:#ffebee;border:1px solid #ef9a9a;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:11px">' +
        '🚨 <strong>약품 재고 부족:</strong> ' + drugLow.map(function(i){return i.name+'('+i.qty+i.unit+')';}).join(', ') + ' — ' +
        '<a href="#" onclick="renderScreen(\'inventory\');return false;" style="color:var(--primary)">재고 관리로 이동</a>' +
      '</div>' : '') +
    '<div class="grid-2" style="margin-bottom:14px">' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">📋 조제 대기 목록</div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>처방번호</th><th>환자명</th><th>처방의</th><th>약품수</th><th>발행시간</th><th>DUR</th><th>상태</th><th>관리</th></tr></thead>' +
          '<tbody>' + waitHtml + '</tbody>' +
        '</table></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">⚠ DUR 점검 결과</div></div>' +
        durHtml +
        '<div style="margin-top:10px;padding:8px;background:#e3f2fd;border-radius:6px;font-size:11px;color:#1565c0">' +
          'ℹ DUR(의약품안전사용서비스): 병용금기·연령금기·임부금기·용량·투여기간 자동 점검' +
        '</div>' +
      '</div>' +
    '</div>' +
    (done.length>0?
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">✅ 오늘 완료된 조제</div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>처방번호</th><th>환자명</th><th>처방의</th><th>약품수</th><th>완료시간</th><th>상태</th></tr></thead>' +
          '<tbody>' + done.slice().reverse().map(doneRow).join('') + '</tbody>' +
        '</table></div>' +
      '</div>' : '');
}

function openPrescriptionDetail(prxId) {
  var prx = (DB.prescriptions||[]).find(function(p){return p.id===prxId;});
  if(!prx) return;
  var drugsHtml = (prx.drugs||[]).length===0
    ? '<div style="padding:12px;color:var(--text-muted)">처방 약품 없음</div>'
    : (prx.drugs||[]).map(function(d,i){
        return '<div style="padding:8px 0;border-bottom:1px solid #f5f5f5">' +
          '<div style="font-weight:600">' + (i+1) + '. ' + d.name + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:3px">' + (d.detail||'-') + '</div>' +
        '</div>';
      }).join('');
  openDynamicModal('modal-prx-detail',
    '<div class="modal-title">💊 처방 확인 — ' + prx.ptName + '</div>',
    '<div style="background:#f8fafd;border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px">' +
      '<div class="grid-2">' +
        '<div><strong>처방번호:</strong> ' + prx.id + '</div>' +
        '<div><strong>환자:</strong> ' + prx.ptName + '</div>' +
        '<div><strong>처방의:</strong> ' + (prx.doctor||'-') + '</div>' +
        '<div><strong>처방일시:</strong> ' + (prx.issuedAt||'').substring(0,16).replace('T',' ') + '</div>' +
      '</div>' +
    '</div>' +
    (prx.durWarning?'<div class="claim-warn error" style="margin-bottom:10px"><span class="claim-icon">🚫</span><div><strong>DUR 경고:</strong> ' + prx.durMessage + '</div></div>':'') +
    '<div style="font-weight:700;margin-bottom:8px">처방 약품 (' + (prx.drugCount||0) + '종)</div>' +
    drugsHtml,
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-prx-detail\').classList.remove(\'open\')">닫기</button>' +
    '<button class="btn btn-primary" onclick="completeDispense(\'' + prxId + '\');document.getElementById(\'modal-prx-detail\').classList.remove(\'open\')">✓ 조제 완료</button>'
  );
}

function showDURDetail(prxId) {
  openPrescriptionDetail(prxId);
}


// ─── renderNursing ───────────────────────────────────────
function renderNursing(el) {
  var wards = DB.wardPatients || [];
  var today = new Date().toLocaleDateString('ko-KR', {month:'long', day:'numeric'});

  function vitalsRow(wp) {
    var v = wp.vitals || {};
    var bpAlert = v.bp && parseInt((v.bp||'0').split('/')[0]) > 160;
    return '<tr' + (bpAlert ? ' style="background:#fff5f5"' : '') + '>' +
      '<td><strong>' + wp.bed + '</strong></td>' +
      '<td>' + wp.name + '<small style="color:var(--text-muted)"> (' + (wp.age||'') + '/' + (wp.gender||'') + ')</small></td>' +
      '<td' + (bpAlert ? ' class="lab-H"' : '') + '>' + (v.bp||'-') + '</td>' +
      '<td>' + (v.hr||'-') + '</td>' +
      '<td>' + (v.bt||'-') + '</td>' +
      '<td>' + (v.spo2||'-') + '</td>' +
      '<td>' + (v.vas||'-') + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (v.time||'-') + '</td>' +
      '<td>' +
        '<div class="btn-group">' +
          '<button class="btn btn-sm btn-primary" onclick="openNursingVSModal(\'' + wp.bed.replace(/'/g,"\\'") + '\')">V/S</button>' +
          '<button class="btn btn-sm btn-ghost" onclick="openNursingRecord(\'' + wp.bed.replace(/'/g,"\\'") + '\')">기록</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  var vitalsHtml = wards.length === 0
    ? '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--text-muted)">입원 환자 없음 — 병동 화면에서 입원 등록 후 표시됩니다</td></tr>'
    : wards.map(vitalsRow).join('');

  // 오늘 간호기록 요약
  var alerts = (DB.notifications||[]).filter(function(n){return !n.read && n.type==='vital_alert';});

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">📋 간호기록 — ' + today + '</div>' +
      '<div class="btn-group">' +
        '<button class="btn btn-outline" onclick="openModal(\'modal-nursing\')">+ 간호기록 작성</button>' +
        '<button class="btn btn-primary" onclick="openNursingVSModal(\'all\')">📊 일괄 V/S 입력</button>' +
      '</div>' +
    '</div>' +
    (alerts.length > 0 ?
      '<div style="background:#ffebee;border:1.5px solid #ef9a9a;border-radius:8px;padding:10px 14px;margin-bottom:12px">' +
        '<strong style="color:#b71c1c">🚨 활력징후 이상 ' + alerts.length + '건</strong><br>' +
        '<span style="font-size:11px;color:#c62828">' +
          alerts.slice(0,3).map(function(n){return n.message;}).join(' / ') +
        '</span>' +
      '</div>' : '') +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">입원 환자</div><div class="stat-value">' + wards.length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">V/S 이상</div><div class="stat-value">' + wards.filter(function(w){return w.vitals&&parseInt((w.vitals.bp||'0').split('/')[0])>160;}).length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">V/S 미측정</div><div class="stat-value">' + wards.filter(function(w){return !w.vitals||!w.vitals.time;}).length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">정상</div><div class="stat-value">' + wards.filter(function(w){return w.vitals&&w.vitals.time&&parseInt((w.vitals.bp||'0').split('/')[0])<=160;}).length + '</div></div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">활력징후 현황</div>' +
        '<button class="btn btn-sm btn-outline" onclick="openModal(\'modal-nursing\')">+ 간호기록</button>' +
      '</div>' +
      '<div class="tbl-wrap"><table class="vitals-table">' +
        '<thead><tr><th>병상</th><th>환자</th><th>BP</th><th>HR</th><th>BT</th><th>SpO₂</th><th>VAS</th><th>측정시간</th><th>관리</th></tr></thead>' +
        '<tbody>' + vitalsHtml + '</tbody>' +
      '</table></div>' +
    '</div>';
}

// ─── renderLab ───────────────────────────────────────────
function renderLab(el) {
  var labs    = DB.labResults || [];
  var pending = labs.filter(function(l){return l.status==='pending';});
  var critical= labs.filter(function(l){return l.status==='critical';});
  var normal  = labs.filter(function(l){return l.status==='normal'||l.status==='received';});

  function labRow(r) {
    var isCrit = r.status==='critical';
    return '<tr' + (isCrit?' style="background:#fff5f5"':'') + '>' +
      '<td style="font-family:var(--mono);font-size:10px">' + r.id + '</td>' +
      '<td><strong>' + r.ptName + '</strong></td>' +
      '<td style="font-size:11px">' + r.testName + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (r.orderedDate||'-') + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (r.resultDate||'-') + '</td>' +
      '<td style="font-weight:700;color:' + (isCrit?'var(--danger)':r.status==='normal'?'var(--success)':'inherit') + '">' +
        (r.result||'-') + (r.unit?' '+r.unit:'') +
      '</td>' +
      '<td><span class="badge ' + (isCrit?'badge-urgent':r.status==='pending'?'badge-waiting':'badge-done') + '">' +
        (isCrit?'⚠ 위험':r.status==='pending'?'대기':r.status==='normal'?'정상':'수신') +
      '</span></td>' +
      '<td>' +
        '<div class="btn-group">' +
          (isCrit?'<button class="btn btn-sm btn-danger" onclick="notifyCritical(\'' + r.id + '\')">주치의 알림</button>':'') +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  var listHtml = labs.length === 0
    ? '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">검사 결과 없음 — "검사 의뢰" 버튼으로 추가하세요</td></tr>'
    : labs.slice().reverse().map(labRow).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">🔬 검사 결과</div>' +
      '<button class="btn btn-primary" onclick="openAddLabModal()">+ 검사 의뢰</button>' +
    '</div>' +
    (critical.length>0?
      '<div style="background:#ffebee;border:1.5px solid #ef9a9a;border-radius:8px;padding:12px 14px;margin-bottom:12px">' +
        '<strong style="color:#b71c1c">🚨 위험값 ' + critical.length + '건 — 즉시 주치의 확인 필요</strong><br>' +
        '<span style="font-size:11px;color:#c62828">' +
          critical.map(function(r){return r.ptName+' '+r.testName+': '+r.result;}).join(' / ') +
        '</span>' +
      '</div>' : '') +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">전체</div><div class="stat-value">' + labs.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">결과 수신</div><div class="stat-value">' + normal.length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">대기</div><div class="stat-value">' + pending.length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">위험값</div><div class="stat-value">' + critical.length + '</div>' + (critical.length>0?'<div class="stat-sub">즉시 확인</div>':'') + '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">검사 결과 목록</div></div>' +
      '<div class="tbl-wrap"><table>' +
        '<thead><tr><th>번호</th><th>환자명</th><th>검사명</th><th>의뢰일</th><th>결과일</th><th>결과값</th><th>판정</th><th>관리</th></tr></thead>' +
        '<tbody>' + listHtml + '</tbody>' +
      '</table></div>' +
    '</div>';
}

// ─── renderConsent ───────────────────────────────────────
function renderConsent(el) {
  var cons    = DB.consents || [];
  var pending = cons.filter(function(c){return c.status==='pending';});
  var signed  = cons.filter(function(c){return c.status==='signed';});

  function conRow(con) {
    return '<tr>' +
      '<td><strong>' + con.ptName + '</strong></td>' +
      '<td style="font-size:11px">' + con.type + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (con.issuedDate||'-') + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px;color:' + (con.signedDate==='-'?'var(--warning)':'inherit') + '">' + (con.signedDate||'-') + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (con.expDate||'-') + '</td>' +
      '<td><span class="badge ' + (con.status==='signed'?'badge-done':con.status==='expired'?'badge-cancel':'badge-waiting') + '">' +
        (con.status==='signed'?'서명완료':con.status==='expired'?'만료':'서명대기') +
      '</span></td>' +
      '<td>' +
        '<div class="btn-group">' +
          (con.status==='pending'?'<button class="btn btn-sm btn-primary" onclick="signConsent(\'' + con.id + '\')">서명</button>':'') +
          '<button class="btn btn-sm btn-ghost" onclick="notify(\'출력\',\'동의서를 출력합니다.\',\'info\')">출력</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  var listHtml = cons.length === 0
    ? '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">등록된 동의서 없음 — "+ 동의서 발행" 버튼으로 추가하세요</td></tr>'
    : cons.slice().reverse().map(conRow).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">📜 전자 동의서 관리</div>' +
      '<button class="btn btn-primary" onclick="openModal(\'modal-consent\')">+ 동의서 발행</button>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">전체</div><div class="stat-value">' + cons.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">서명 완료</div><div class="stat-value">' + signed.length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">서명 대기</div><div class="stat-value">' + pending.length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">만료 임박</div><div class="stat-value">' +
        cons.filter(function(c){if(c.status!=='signed'||!c.expDate)return false;var d=(new Date(c.expDate)-new Date())/86400000;return d>=0&&d<=30;}).length +
      '</div></div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">동의서 목록</div></div>' +
      '<div class="tbl-wrap"><table>' +
        '<thead><tr><th>환자명</th><th>동의서 종류</th><th>발행일</th><th>서명일</th><th>만료일</th><th>상태</th><th>관리</th></tr></thead>' +
        '<tbody>' + listHtml + '</tbody>' +
      '</table></div>' +
    '</div>';
}

// ─── renderStaff ─────────────────────────────────────────
// ─── renderSettings ──────────────────────────────────────
function renderSettings(el) {
  el.innerHTML =
    '<div class="section-title">⚙ 시스템 설정</div>' +
    '<div class="grid-2" style="gap:16px">' +

      // ── 병원 정보 ──
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">🏥 병원 정보</div></div>' +
        '<div style="padding:4px 0">' +
          '<div class="form-group"><label>병원명</label>' +
            '<input class="form-control" id="set-hosp-name" value="정동병원"></div>' +
          '<div class="form-group"><label>대표자 이름</label>' +
            '<input class="form-control" id="set-hosp-ceo" placeholder="병원장/대표자 이름"></div>' +
          '<div class="form-group"><label>대표 전화</label>' +
            '<input class="form-control" id="set-hosp-tel" value="02-0000-0000"></div>' +
          '<div class="form-group"><label>주소</label>' +
            '<input class="form-control" id="set-hosp-addr" placeholder="병원 주소"></div>' +
          '<div class="form-group"><label>요양기관 번호</label>' +
            '<input class="form-control" id="set-hosp-code" placeholder="심평원 요양기관 기호"></div>' +
          '<div class="form-group"><label>사업자 등록번호</label>' +
            '<input class="form-control" id="set-hosp-biz" placeholder="000-00-00000"></div>' +
        '</div>' +
        '<div style="padding:8px 0;border-top:1px solid var(--border);margin-top:8px">' +
          '<button class="btn btn-primary" onclick="notify(\'저장\',\'병원 정보가 저장되었습니다.\',\'success\')">✓ 저장</button>' +
        '</div>' +
      '</div>' +

      // ── EMR 설정 ──
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">📋 EMR 설정</div></div>' +
        '<div style="padding:4px 0">' +
          '<div class="form-group"><label>차트 잠금 시간 (분)</label>' +
            '<input class="form-control" type="number" id="set-lock-min" value="30" min="5" max="120"></div>' +
          '<div class="form-group"><label>Addendum 최소 사유 글자수</label>' +
            '<input class="form-control" type="number" id="set-addendum-min" value="10" min="5" max="100"></div>' +
          '<div class="form-group"><label>자동 저장 간격 (초)</label>' +
            '<input class="form-control" type="number" id="set-autosave" value="60" min="10" max="300"></div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-top:8px">' +
            '<label style="font-weight:600;font-size:12px">처방 저장 시 약제실 자동 연동</label>' +
            '<input type="checkbox" id="set-rx-auto" checked style="width:16px;height:16px">' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-top:8px">' +
            '<label style="font-weight:600;font-size:12px">DUR 자동 점검</label>' +
            '<input type="checkbox" id="set-dur" checked style="width:16px;height:16px">' +
          '</div>' +
        '</div>' +
        '<div style="padding:8px 0;border-top:1px solid var(--border);margin-top:8px">' +
          '<button class="btn btn-primary" onclick="notify(\'저장\',\'EMR 설정이 저장되었습니다.\',\'success\')">✓ 저장</button>' +
        '</div>' +
      '</div>' +

      // ── 보안 설정 ──
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">🔒 보안 설정</div></div>' +
        '<div style="padding:4px 0">' +
          '<div class="form-group"><label>세션 만료 시간 (분)</label>' +
            '<input class="form-control" type="number" id="set-session" value="120" min="30" max="480"></div>' +
          '<div class="form-group"><label>비밀번호 최소 길이</label>' +
            '<input class="form-control" type="number" id="set-pw-min" value="8" min="6" max="20"></div>' +
          '<div class="form-group"><label>로그인 실패 허용 횟수</label>' +
            '<input class="form-control" type="number" id="set-login-fail" value="5" min="3" max="10"></div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-top:8px">' +
            '<label style="font-weight:600;font-size:12px">접속 로그 기록</label>' +
            '<input type="checkbox" id="set-audit" checked style="width:16px;height:16px">' +
          '</div>' +
        '</div>' +
        '<div style="padding:8px 0;border-top:1px solid var(--border);margin-top:8px">' +
          '<button class="btn btn-primary" onclick="notify(\'저장\',\'보안 설정이 저장되었습니다.\',\'success\')">✓ 저장</button>' +
        '</div>' +
      '</div>' +

      // ── 데이터 관리 ──
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">🗄 데이터 관리</div></div>' +
        '<div style="padding:4px 0">' +
          '<div style="margin-bottom:12px">' +
            '<div style="font-size:12px;font-weight:700;margin-bottom:6px">현재 DB 현황</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">' +
              (function(){
                var items = [
                  ['등록 환자', DB.patientMaster.length + '명'],
                  ['EMR 차트', DB.emrCharts.length + '건'],
                  ['수납 내역', (DB.payments||[]).length + '건'],
                  ['입원 환자', DB.wardPatients.length + '명'],
                  ['처방 기록', (DB.prescriptions||[]).length + '건'],
                  ['재고 품목', DB.inventory.length + '종'],
                  ['예약 내역', (DB.reservations||[]).length + '건'],
                  ['감사 로그', (DB.auditLog||[]).length + '건'],
                ];
                return items.map(function(it){
                  return '<div style="background:#f8fafd;border-radius:4px;padding:5px 8px">' +
                    '<span style="color:var(--text-muted)">' + it[0] + ':</span> <strong>' + it[1] + '</strong>' +
                  '</div>';
                }).join('');
              })() +
            '</div>' +
          '</div>' +
          '<div style="border-top:1px solid var(--border);padding-top:10px">' +
            '<button class="btn btn-outline" style="width:100%" onclick="exportAuditLog()">📥 감사 로그 내보내기</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

    '</div>' +


    // ── 서버 연결 가이드 ──
    '<div class="card" style="margin-top:16px">' +
      '<div class="card-header"><div class="card-title">🔌 백엔드 서버 연결 가이드</div></div>' +
      '<div style="padding:4px 0">' +
        '<div style="background:#1a2332;border-radius:8px;padding:14px 16px;font-family:var(--mono);font-size:11px;color:#a8bcd8;line-height:1.8;margin-bottom:12px">' +
          '<div style="color:#00c896;margin-bottom:6px">// 1. API 엔드포인트 설정 (config.js)</div>' +
          '<div>const API_BASE = <span style="color:#ffd700">"https://api.jungdong.kr/v1"</span>;</div>' +
          '<div style="color:#a8bcd8">const WS_URL = <span style="color:#ffd700">"wss://api.jungdong.kr/ws"</span>;</div>' +
          '<div style="margin-top:8px;color:#00c896">// 2. 인증 (JWT)</div>' +
          '<div>Authorization: Bearer <span style="color:#ffd700">{token}</span></div>' +
          '<div style="margin-top:8px;color:#00c896">// 3. 심평원 자격조회 연동 (EDI)</div>' +
          '<div>GET /hira/eligibility?pid=<span style="color:#ffd700">{환자등록번호}</span></div>' +
          '<div style="margin-top:8px;color:#00c896">// 4. PACS 연동 (DICOM)</div>' +
          '<div>PACS_URL = <span style="color:#ffd700">"http://192.168.1.20:8042"</span></div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">' +
          '<div style="background:#f0fdf4;border-radius:6px;padding:10px">' +
            '<div style="font-weight:700;color:var(--success);margin-bottom:6px">✅ 현재 구현된 연동</div>' +
            '<ul style="margin:0;padding-left:16px;line-height:2">' +
              '<li>DB 내부 (브라우저 메모리)</li>' +
              '<li>수납 VAN 모의 처리</li>' +
              '<li>카카오 예약 UI</li>' +
              '<li>알림 실시간 뱃지</li>' +
            '</ul>' +
          '</div>' +
          '<div style="background:#fff8e1;border-radius:6px;padding:10px">' +
            '<div style="font-weight:700;color:var(--warning);margin-bottom:6px">🔧 실서버 연동 필요</div>' +
            '<ul style="margin:0;padding-left:16px;line-height:2">' +
              '<li>심평원 자격조회 API</li>' +
              '<li>카카오 비즈 알림톡</li>' +
              '<li>PACS DICOM 서버</li>' +
              '<li>MySQL/DB 영구 저장</li>' +
              '<li>SMS 발송 API</li>' +
            '</ul>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:12px;padding:10px;background:#e3f2fd;border-radius:6px;font-size:11px">' +
          '<strong style="color:#1565c0">📌 실서버 연결 방법:</strong> ' +
          '이 HTML 파일을 기반으로 Vue.js/React로 마이그레이션하거나, ' +
          'fetch() API를 사용해 백엔드(Node.js/Spring)와 통신하도록 수정하세요. ' +
          'DB 객체의 모든 변경 시점에 API 호출을 추가하면 됩니다.' +
        '</div>' +
      '</div>' +
    '</div>' +
    '';
}

function exportAuditLog() {
  var logs = DB.auditLog || [];
  if(logs.length === 0) { notify('알림','감사 로그가 없습니다.','info'); return; }
  var rows = ['시간,액션,사용자,대상'].concat(
    logs.map(function(l){
      return [l.time||'',l.action||'',l.user||'',l.target||l.bed||l.code||''].join(',');
    })
  );
  var blob = new Blob(['\uFEFF'+rows.join('\n')], {type:'text/csv;charset=utf-8'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'audit_log_' + new Date().toISOString().substring(0,10) + '.csv';
  a.click();
  notify('내보내기','감사 로그 CSV를 다운로드합니다.','success');
}



function openDoctorSchedule(uid) {
  var user = DB.users.find(function(u){return u.id===uid;});
  if(!user){notify('오류','의사를 찾을 수 없습니다.','error');return;}
  var sched = user.schedule || {};
  var days = ['mon','tue','wed','thu','fri','sat'];
  var dayLabel = {mon:'월요일',tue:'화요일',wed:'수요일',thu:'목요일',fri:'금요일',sat:'토요일'};
  
  // 편집 폼
  var formHtml = '<div style="display:grid;gap:12px">';
  days.forEach(function(d){
    var s = sched[d]||{am:'clinic',pm:'clinic',reason:''};
    var isSaturday = (d === 'sat');
    formHtml += 
      '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;background:#f8fafd">' +
        '<div style="font-weight:700;margin-bottom:10px">'+dayLabel[d]+(isSaturday?' (오전만)':'')+'</div>' +
        '<div style="display:grid;grid-template-columns:80px 1fr 1fr;gap:10px;align-items:center;margin-bottom:8px">' +
          '<label style="font-size:11px;color:var(--text-muted);font-weight:600">오전</label>' +
          '<select class="form-control" id="sched-am-'+d+'" style="font-size:12px">' +
            '<option value="clinic" '+(s.am==='clinic'?'selected':'')+'>🏥 진료</option>' +
            '<option value="surgery" '+(s.am==='surgery'?'selected':'')+'>🔪 수술</option>' +
            '<option value="closed" '+(s.am==='closed'?'selected':'')+'>⛔ 휴진</option>' +
          '</select>' +
        '</div>';
    if(!isSaturday) {
      formHtml += 
        '<div style="display:grid;grid-template-columns:80px 1fr 1fr;gap:10px;align-items:center;margin-bottom:8px">' +
          '<label style="font-size:11px;color:var(--text-muted);font-weight:600">오후</label>' +
          '<select class="form-control" id="sched-pm-'+d+'" style="font-size:12px">' +
            '<option value="clinic" '+(s.pm==='clinic'?'selected':'')+'>🏥 진료</option>' +
            '<option value="surgery" '+(s.pm==='surgery'?'selected':'')+'>🔪 수술</option>' +
            '<option value="closed" '+(s.pm==='closed'?'selected':'')+'>⛔ 휴진</option>' +
          '</select>' +
        '</div>';
    }
    formHtml += 
        '<div style="display:grid;grid-template-columns:80px 1fr;gap:10px;align-items:center">' +
          '<label style="font-size:11px;color:var(--text-muted);font-weight:600">메모</label>' +
          '<input class="form-control" id="sched-reason-'+d+'" placeholder="특이사항 입력" value="'+(s.reason||'')+'" style="font-size:12px">' +
        '</div>' +
      '</div>';
  });
  formHtml += '</div>';

  openDynamicModal('modal-doc-schedule',
    '<div class="modal-title">📅 '+user.name+' 진료/수술 시간표 편집</div>',
    formHtml,
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-doc-schedule\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveDoctorSchedule(\''+uid+'\',\''+user.name+'\')">✓ 저장</button>'
  );
}

function saveDoctorSchedule(uid, uname) {
  var user = DB.users.find(function(u){return u.id===uid;});
  if(!user){notify('오류','의사를 찾을 수 없습니다.','error');return;}
  
  var days = ['mon','tue','wed','thu','fri','sat'];
  var newSchedule = {};
  
  days.forEach(function(d){
    var am = document.getElementById('sched-am-'+d).value;
    var pm = (d === 'sat') ? 'closed' : (document.getElementById('sched-pm-'+d).value);
    var reason = document.getElementById('sched-reason-'+d).value || '';
    
    newSchedule[d] = {
      am: am,
      pm: pm,
      reason: reason
    };
  });
  
  user.schedule = newSchedule;
  
  // 감사 로그
  DB.auditLog.push({
    time: new Date().toISOString(),
    action: 'DOCTOR_SCHEDULE_UPDATED',
    user: SESSION.user ? SESSION.user.username : '-',
    doctor: uname,
    schedule: newSchedule
  });
  
  document.getElementById('modal-doc-schedule').classList.remove('open');
  notify('저장 완료', uname + ' 의사의 시간표가 저장되었습니다.', 'success');
  renderScreen('staff');
}

function openVacationModal(uid, uname) {
  var today = new Date().toISOString().substring(0,10);
  openDynamicModal('modal-vacation',
    '<div class="modal-title">🏖 휴진 등록 — '+uname+'</div>',
    '<div class="form-group"><label>* 휴진 날짜</label>' +
      '<input class="form-control" type="date" id="vac-date" value="'+today+'" min="'+today+'"></div>' +
    '<div class="form-group"><label>휴진 범위</label>' +
      '<select class="form-control" id="vac-type">' +
        '<option value="all">전일 휴진</option>' +
        '<option value="am">오전 휴진 (오후 진료)</option>' +
        '<option value="pm">오후 휴진 (오전 진료)</option>' +
      '</select></div>' +
    '<div class="form-group"><label>* 휴진 사유</label>' +
      '<input class="form-control" id="vac-reason" placeholder="예: 학회 참석, 개인 사정 등"></div>' +
    '<div style="background:#fff3e0;border-radius:6px;padding:10px;font-size:11px;color:#e65100;margin-top:8px">' +
      '⚠ 휴진 등록 시 해당 날짜 예약 슬롯이 비활성화되고 알림이 발송됩니다.' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-vacation\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-warning" onclick="saveVacation(\''+uid+'\',\''+uname+'\')">✓ 휴진 등록</button>'
  );
}

function saveVacation(uid, uname) {
  var dateVal  = (document.getElementById('vac-date')||{}).value||'';
  var typeVal  = (document.getElementById('vac-type')||{}).value||'all';
  var reason   = (document.getElementById('vac-reason')||{}).value||'';
  if(!dateVal){notify('오류','날짜를 선택하세요.','error');return;}
  if(!reason.trim()){notify('오류','휴진 사유를 입력하세요.','error');return;}

  // DB.users에 휴진 날짜 기록
  var user = DB.users.find(function(u){return u.id===uid;});
  if(user) {
    if(!user.vacations) user.vacations = [];
    user.vacations.push({
      date:dateVal, type:typeVal, reason:reason,
      registeredAt:new Date().toISOString(),
      registeredBy:SESSION.user?SESSION.user.name:'-',
    });
  }

  // 알림 생성
  var typeLabel = {all:'전일',am:'오전',pm:'오후'}[typeVal]||typeVal;
  var dateObj = new Date(dateVal);
  var weekDays = ['일','월','화','수','목','금','토'];
  var dateLabel = dateVal + '(' + weekDays[dateObj.getDay()] + ')';

  DB.notifications.push({
    id:'NTF-'+Date.now(), type:'vacation_notice', level:'warning',
    message:'🏖 휴진: '+uname+' '+dateLabel+' '+typeLabel+' 휴진 — '+reason,
    time:new Date().toISOString(), read:false,
  });
  updateNotifBadge();
  DB.auditLog.push({time:new Date().toISOString(),action:'VACATION_REGISTERED',
    user:SESSION.user?SESSION.user.username:'-',doctor:uname,date:dateVal,type:typeVal,reason});

  // 해당 날짜 예약 비활성화를 위해 vacationDays에 등록
  if(!DB.vacationDays) DB.vacationDays = {};
  DB.vacationDays[uid+'_'+dateVal] = {uid, uname, date:dateVal, type:typeVal, reason};

  document.getElementById('modal-vacation').classList.remove('open');
  notify('휴진 등록', uname+' '+dateLabel+' '+typeLabel+' 휴진이 등록되었습니다. 알림 발송됨.', 'success');
  renderScreen('staff');
}


function renderStaff(el) {
  // 직원 관리: 현재 활성 계정 목록 + 부서별 현황 (계정 관리와 달리 보기 전용)
  var users = DB.users.filter(function(u){ return u.status === 'active'; });
  var deptLabel = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과·건강검진',
    anesthesia:'마취통증의학과',radiology:'영상의학과',pt:'물리치료',nonsurg:'비수술치료',
    or:'수술실',ward:'병동',pharmacy:'약제실',reception:'원무',finance:'재무',
    claim_mgmt:'심사청구',admin:'관리자'};
  var roleLabel = {hospital_director:'병원장',doctor_ortho1:'정형외과의',doctor_ortho2:'정형외과의',
    doctor_neuro:'신경외과의',doctor_internal:'내과의',doctor_anesthesia:'마취과의',
    doctor_radiology:'영상의학과의',nurse:'간호사',pharmacist:'약사',pt_therapist:'물리치료사',
    radiographer:'방사선사',reception:'원무담당',finance_staff:'재무담당',claim_staff:'심사청구',admin:'관리자'};

  // 부서별 그룹핑
  var deptGroups = {};
  users.forEach(function(u){
    var d = u.dept||'기타';
    if(!deptGroups[d]) deptGroups[d] = [];
    deptGroups[d].push(u);
  });

  var staffCards = Object.keys(deptGroups).sort().map(function(dept){
    var members = deptGroups[dept];
    return '<div class="card" style="margin-bottom:12px">' +
      '<div class="card-header" style="background:var(--sidebar);color:#fff;border-radius:8px 8px 0 0;padding:8px 14px">' +
        '<div class="card-title" style="color:#fff">🏥 ' + (deptLabel[dept]||dept) + '</div>' +
        '<span style="font-size:11px;color:rgba(255,255,255,0.7)">' + members.length + '명</span>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;padding:12px">' +
        members.map(function(u){
          return '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;gap:10px;align-items:center">' +
            '<div style="width:40px;height:40px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;flex-shrink:0">' + (u.name||'?')[0] + '</div>' +
            '<div style="min-width:0">' +
              '<div style="font-weight:700;font-size:13px">' + u.name + '</div>' +
              '<div style="font-size:11px;color:var(--text-muted)">' + (roleLabel[u.role]||u.role) + '</div>' +
              '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">' + (u.phone||'-') + '</div>' +
              (u.spec?'<div style="font-size:10px;color:var(--primary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+u.spec+'</div>':'') +
              ((u.role.startsWith('doctor_')||u.role==='hospital_director')?
                '<div style="margin-top:6px;display:flex;gap:4px">' +
                  '<button class="btn btn-sm btn-ghost" style="font-size:10px;padding:2px 6px" onclick="openDoctorSchedule(\'' + u.id + '\')">📅 시간표</button>' +
                  '<button class="btn btn-sm btn-warning" style="font-size:10px;padding:2px 6px" onclick="openVacationModal(\'' + u.id + '\',\'' + u.name + '\')">🏖 휴진</button>' +
                '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
    '</div>';
  }).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">👨‍⚕️ 직원 현황</div>' +
      '<div class="btn-group">' +
        '<span style="font-size:12px;color:var(--text-muted)">총 ' + users.length + '명 재직중</span>' +
        '<button class="btn btn-primary" onclick="renderScreen(\'users\')">계정 관리 →</button>' +
      '</div>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">전체 직원</div><div class="stat-value">' + users.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">의사</div><div class="stat-value">' + users.filter(function(u){return u.role.startsWith('doctor_')||u.role==='hospital_director';}).length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">간호/의료기사</div><div class="stat-value">' + users.filter(function(u){return ['nurse','pharmacist','pt_therapist','radiographer'].includes(u.role);}).length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">행정/지원</div><div class="stat-value">' + users.filter(function(u){return ['reception','finance_staff','claim_staff','admin'].includes(u.role);}).length + '</div></div>' +
    '</div>' +
    (users.length===0?
      '<div style="text-align:center;padding:40px;color:var(--text-muted)">등록된 직원 없음 — 계정 관리에서 계정을 등록하세요<br><br><button class="btn btn-primary" onclick="renderScreen(\'users\')">계정 관리로 이동</button></div>' :
      staffCards);
}



function renderPT(el) {
  el.innerHTML = `
  <div class="section-title">🏃 물리치료센터 — 치료 현황</div>
  <div class="grid-4" style="margin-bottom:16px">
    <div class="stat-card blue"><div class="stat-label">오늘 치료 예약</div><div class="stat-value">23</div></div>
    <div class="stat-card green"><div class="stat-label">완료</div><div class="stat-value">15</div></div>
    <div class="stat-card orange"><div class="stat-label">대기</div><div class="stat-value">6</div></div>
    <div class="stat-card red"><div class="stat-label">주 횟수 초과 주의</div><div class="stat-value">2</div></div>
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">치료 대기 현황</div><button class="btn btn-sm btn-primary">+ 치료 등록</button></div>
    <table>
      <thead><tr><th>순번</th><th>환자명</th><th>처방의</th><th>치료 종류</th><th>이번주 횟수</th><th>심평원 허용</th><th>상태</th><th>관리</th></tr></thead>
      <tbody>
        ${[
          ...(DB.ptSchedules||[]).filter(function(s){return s.type!=='nonsurg';}).slice(0,8).map(function(s,i){return {no:i+1,name:s.ptName,dr:s.doctor||'-',type:s.treatType||'-',week:s.weekCount||0,max:s.weekMax||5,status:s.status==='in_progress'?'치료중':s.status==='completed'?'완료':'대기'};})].filter(function(x){return x.no;}).map(r => `<tr>
          <td>${r.no}</td>
          <td><strong>${r.name}</strong></td>
          <td>${r.dr}</td>
          <td>${r.type}</td>
          <td style="font-weight:700;color:${r.week>=r.max?'var(--danger)':'var(--success)'}">${r.week}회</td>
          <td>주 최대 ${r.max}회</td>
          <td><span class="badge ${r.status==='치료중'?'badge-progress':'badge-waiting'}">${r.status}</span></td>
          <td>
            ${r.week>=r.max ? '<span class="badge badge-urgent" style="font-size:10px">⚠ 초과주의</span>' : ''}
            <button class="btn btn-sm btn-primary" style="margin-left:4px">완료</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="margin-top:12px;padding:10px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;font-size:11px;color:#e65100">
      <strong>⚠ 심평원 청구 주의:</strong> 물리치료는 주 5회 초과 시 삭감 대상. 상세 치료 내용 및 의사 지시 기재 필수. 도수치료는 요양급여 적용 횟수 확인 필요.
    </div>
  </div>`;
}

function renderReservation(el) {
  var state = el._state || { year: new Date().getFullYear(), month: new Date().getMonth(), view:'month', filterDept:'' };
  el._state = state;

  if(!DB.reservationsLoaded) {
    DB.reservationsLoaded = true;
    loadReservations().then(function(){ renderReservation(el); });
    return;
  }

  var days = ['일','월','화','수','목','금','토'];
  var deptLabel = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',
    internal:'내과·건강검진',anesthesia:'마취통증의학과',health:'건강검진센터',
    pt:'물리치료',nonsurg:'비수술치료',all:'전체 진료과'};

  // 오늘 예약 목록
  var todayStr = new Date().toISOString().substring(0,10);
  var todayResv = (DB.reservations||[]).filter(function(r){return r.date===todayStr;})
    .sort(function(a,b){return a.time<b.time?-1:1;});

  // 이번달 예약 달력 데이터
  var monthStr = state.year + '-' + String(state.month+1).padStart(2,'0');
  var dbAppts = {};
  (DB.reservations||[]).filter(function(r){
    return r.date && r.date.startsWith(monthStr) && (!state.filterDept || r.dept===state.filterDept);
  }).forEach(function(r){
    var d = parseInt(r.date.split('-')[2]);
    if(!dbAppts[d]) dbAppts[d] = [];
    dbAppts[d].push(r);
  });

  var firstDay = new Date(state.year, state.month, 1).getDay();
  var lastDate = new Date(state.year, state.month+1, 0).getDate();
  var todayDate = new Date().getDate();
  var isCurrentMonth = state.year===new Date().getFullYear() && state.month===new Date().getMonth();

  // 달력 셀 생성
  function calCell(d) {
    if(!d) return '<div class="cal-cell empty"></div>';
    var dateStr = state.year+'-'+String(state.month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var dow = new Date(state.year, state.month, d).getDay();
    var isHoliday = isKoreanHoliday(state.year, state.month+1, d);
    var isSun = dow===0, isSat = dow===6;
    var isToday = isCurrentMonth && d===todayDate;
    var appts = dbAppts[d] || [];
    var isPast = new Date(dateStr) < new Date(new Date().toISOString().substring(0,10));

    return '<div class="cal-cell' + (isToday?' today':'') + (isPast?' past':'') + '" ' +
      'onclick="addReservation(\'' + dateStr + '\')" style="cursor:pointer;min-height:72px;padding:4px">' +
      '<div style="font-weight:700;font-size:12px;margin-bottom:3px;color:' +
        (isToday?'#fff':isSun||isHoliday?'var(--danger)':isSat?'#1565c0':'inherit') + '">' +
        d + (isHoliday?' 🔴':'') +
      '</div>' +
      appts.slice(0,3).map(function(r){
        var c2 = {ortho1:'#1a4fa0',ortho2:'#1565c0',neuro:'#4527a0',internal:'#00695c',
          anesthesia:'#6d4c41',health:'#00796b',pt:'#e65100'}[r.dept]||'#546e7a';
        return '<div style="background:'+c2+';color:#fff;border-radius:3px;padding:1px 4px;font-size:9px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
          r.time + ' ' + (r.patient||'').split('(')[0].trim().substring(0,4) +
        '</div>';
      }).join('') +
      (appts.length>3?'<div style="font-size:9px;color:var(--text-muted)">+' + (appts.length-3) + '건</div>':'') +
    '</div>';
  }

  // 달력 HTML
  var calCells = '';
  for(var i=0; i<firstDay; i++) calCells += calCell(null);
  for(var d=1; d<=lastDate; d++) calCells += calCell(d);

  // 오늘 예약 행
  function todayRow(r) {
    var c3 = {ortho1:'#1a4fa0',ortho2:'#1565c0',neuro:'#4527a0',internal:'#00695c',anesthesia:'#6d4c41',health:'#00796b'}[r.dept]||'#546e7a';
    return '<tr>' +
      '<td style="font-family:var(--mono);font-weight:700;color:var(--primary)">' + r.time + '</td>' +
      '<td><strong>' + (r.patient||'-').split('(')[0].trim() + '</strong></td>' +
      '<td><span style="font-size:11px;padding:2px 6px;background:'+c3+';color:#fff;border-radius:3px">' + (deptLabel[r.dept]||r.dept||'-') + '</span></td>' +
      '<td>' + (r.doctor||'-') + '</td>' +
      '<td><span class="badge ' + (r.type==='신환'?'badge-new':r.type==='초진'?'badge-first':r.type==='검진'?'badge-admit':'badge-revisit') + '">' + (r.type||'재진') + '</span></td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (r.phone||'-') + '</td>' +
      '<td><span class="badge ' + (r.status==='확정'?'badge-done':'badge-waiting') + '">' + (r.status||'대기') + '</span></td>' +
      '<td>' +
        '<div class="btn-group">' +
          '<button class="btn btn-sm btn-ghost" onclick="cancelReservation(\'' + r.id + '\')">취소</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">📅 예약 관리</div>' +
      '<div class="btn-group">' +
        '<select class="form-control" style="width:auto" onchange="document.getElementById(\'screen-reservation\')._state.filterDept=this.value;renderReservation(document.getElementById(\'screen-reservation\'))">' +
          Object.entries(deptLabel).map(function(e){return '<option value="'+(e[0]==='all'?'':e[0])+'">'+e[1]+'</option>';}).join('') +
        '</select>' +
        '<button class="btn btn-outline" onclick="openKakaoReservationInfo()">💬 카카오 예약 설정</button>' +
        '<button class="btn btn-primary" onclick="addReservation(\'' + todayStr + '\')">+ 예약 등록</button>' +
      '</div>' +
    '</div>' +

    // 통계 카드
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">오늘 예약</div><div class="stat-value">' + todayResv.length + '</div><div class="stat-sub">확정 ' + todayResv.filter(function(r){return r.status==='확정';}).length + '건</div></div>' +
      '<div class="stat-card green"><div class="stat-label">이번달 예약</div><div class="stat-value">' + (DB.reservations||[]).filter(function(r){return r.date&&r.date.startsWith(monthStr);}).length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">취소/대기</div><div class="stat-value">' + (DB.reservations||[]).filter(function(r){return r.date&&r.date.startsWith(monthStr)&&r.status!=='확정';}).length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">카카오 예약</div><div class="stat-value">' + (DB.reservations||[]).filter(function(r){return r.source==='kakao';}).length + '</div><div class="stat-sub">누적</div></div>' +
    '</div>' +

    // 달력
    '<div class="card" style="margin-bottom:14px">' +
      '<div class="card-header">' +
        '<button class="btn btn-ghost btn-sm" onclick="changeResvMonth(-1)">◀</button>' +
        '<div class="card-title">' + state.year + '년 ' + (state.month+1) + '월</div>' +
        '<button class="btn btn-ghost btn-sm" onclick="changeResvMonth(1)">▶</button>' +
        '<button class="btn btn-sm btn-outline" style="margin-left:8px" onclick="var s=document.getElementById(\'screen-reservation\')._state;s.year=new Date().getFullYear();s.month=new Date().getMonth();renderReservation(document.getElementById(\'screen-reservation\'))">오늘</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:#e5e8ed;border:1px solid #e5e8ed;border-radius:6px;overflow:hidden">' +
        days.map(function(d,i){
          return '<div style="background:#f5f7fa;text-align:center;padding:6px 0;font-size:11px;font-weight:700;color:'+(i===0?'var(--danger)':i===6?'#1565c0':'inherit')+'">' + d + '</div>';
        }).join('') +
        calCells.split('</div>').join('</div>\n').split('\n').filter(function(x){return x.trim();}).join('') +
      '</div>' +
    '</div>' +

    // 오늘 예약 목록
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">📋 오늘 예약 목록 (' + todayStr + ')</div>' +
        '<button class="btn btn-sm btn-outline" onclick="addReservation(\'' + todayStr + '\')">+ 예약 추가</button>' +
      '</div>' +
      (todayResv.length===0 ?
        '<div style="text-align:center;padding:24px;color:var(--text-muted)">오늘 예약 없음</div>' :
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>시간</th><th>환자명</th><th>진료과</th><th>담당의</th><th>유형</th><th>연락처</th><th>상태</th><th>관리</th></tr></thead>' +
          '<tbody>' + todayResv.map(todayRow).join('') + '</tbody>' +
        '</table></div>') +
    '</div>';
}

function changeResvMonth(delta) {
  var el = document.getElementById('screen-reservation');
  if(!el) return;
  if(!el._state) el._state = { year: new Date().getFullYear(), month: new Date().getMonth() };
  el._state.month += delta;
  if(el._state.month > 11) { el._state.month = 0; el._state.year++; }
  if(el._state.month < 0)  { el._state.month = 11; el._state.year--; }
  renderReservation(el);
}

async function cancelReservation(id) {
  var r = (DB.reservations||[]).find(function(x){return x.id===id;});
  if(!r) return;
  if(!confirm(r.patient + ' ' + r.date + ' ' + r.time + ' 예약을 취소하시겠습니까?')) return;
  var ok = await cancelReservationBackend(id);
  if(!ok) { notify('예약 취소 실패', '서버에 예약 취소를 반영할 수 없습니다.', 'error'); return; }
  notify('예약 취소', r.patient + ' 예약이 취소되었습니다.', 'info');
  renderScreen('reservation');
}

// ── 한국 공휴일 계산 ─────────────────────────────────────
function isKoreanHoliday(year, month, day) {
  // 고정 공휴일
  var fixed = [
    [1,1],[3,1],[5,5],[6,6],[8,15],[10,3],[10,9],[12,25]
  ];
  for(var i=0; i<fixed.length; i++) {
    if(fixed[i][0]===month && fixed[i][1]===day) return true;
  }
  // 설날 (음력 1/1 전후) - 양력 근사값 (연도별 하드코딩 주요 연도)
  var lunar = {
    2024:[[2,9],[2,10],[2,11],[2,12]],
    2025:[[1,28],[1,29],[1,30],[1,31]],
    2026:[[2,16],[2,17],[2,18],[2,19]],
  };
  // 추석 (음력 8/15 전후)
  var chuseok = {
    2024:[[9,16],[9,17],[9,18],[9,19]],
    2025:[[10,5],[10,6],[10,7],[10,8]],
    2026:[[9,24],[9,25],[9,26],[9,27]],
  };
  var lunarDates = (lunar[year]||[]).concat(chuseok[year]||[]);
  for(var j=0; j<lunarDates.length; j++) {
    if(lunarDates[j][0]===month && lunarDates[j][1]===day) return true;
  }
  // 어린이날 대체 (5/5가 토이면 5/7, 일이면 5/6)
  if(year>=2023) {
    var childDay = new Date(year,4,5).getDay();
    if(childDay===0 && month===5 && day===6) return true;
    if(childDay===6 && month===5 && day===7) return true;
  }
  return false;
}

// ── 진료 가능 시간 슬롯 생성 ─────────────────────────────
function getAvailableSlots(dateStr, dept) {
  var date = new Date(dateStr);
  var dow  = date.getDay(); // 0=일, 6=토
  var month = date.getMonth()+1, day = date.getDate();
  var year = date.getFullYear();

  // 휴무일 체크
  if(dow===0) return [];  // 일요일
  if(isKoreanHoliday(year, month, day)) return [];

  // 진료 시간 설정
  var isHealth = (dept==='health');
  var startH = isHealth ? 8 : 9;
  var startM = isHealth ? 30 : 0;
  var endH   = dow===6 ? 13 : 18;
  var endM   = 0;

  var slots = [];
  var h = startH, m = startM;
  while(h < endH || (h===endH && m < endM)) {
    // 점심 시간 제외 (13:00~14:00, 토요일 제외)
    if(dow!==6 && h===13) { h=14; m=0; continue; }
    var timeStr = ('0'+h).slice(-2) + ':' + ('0'+m).slice(-2);

    // 해당 슬롯 예약 건수 확인 (진료과별 동시 예약 제한: 최대 2)
    var taken = (DB.reservations||[]).filter(function(r){
      return r.date===dateStr && r.time===timeStr && r.status!=='취소' &&
             (dept ? r.dept===dept : true);
    }).length;

    slots.push({ time:timeStr, taken:taken, full: taken>=2 });

    m += 30;
    if(m >= 60) { m=0; h++; }
  }
  return slots;
}


function renderInventory(el) {
  var filterCat = (el._filterCat)||'';
  var filterTxt = (el._filterTxt)||'';
  var inv = DB.inventory.filter(function(i){
    return (!filterCat || i.category===filterCat) &&
           (!filterTxt || i.name.includes(filterTxt) || i.code.includes(filterTxt));
  });
  var lowStock  = DB.inventory.filter(function(i){return i.qty<i.min;});
  var warnStock = DB.inventory.filter(function(i){return i.qty>=i.min && i.qty<i.min*1.2;});
  var pendOrders= (DB.orders||[]).filter(function(o){return o.status==='pending'||o.status==='ordered';});

  function invRow(i) {
    var pct   = Math.min(100, Math.round(i.qty/Math.max(i.min,1)*100));
    var level = i.qty < i.min ? '부족' : i.qty < i.min*1.2 ? '주의' : '정상';
    var color = i.qty < i.min ? 'var(--danger)' : i.qty < i.min*1.2 ? 'var(--warning)' : 'var(--success)';
    var fillCls= i.qty < i.min ? 'stock-empty' : i.qty < i.min*1.2 ? 'stock-low' : 'stock-ok';
    return '<tr' + (i.qty<i.min?' style="background:#fff5f5"':'') + '>' +
      '<td style="font-family:var(--mono);font-size:11px">' + i.code + '</td>' +
      '<td><strong>' + i.name + '</strong></td>' +
      '<td><span style="font-size:11px;padding:2px 6px;background:#f5f7fa;border-radius:3px">' + i.category + '</span></td>' +
      '<td style="font-weight:700;color:' + color + '">' + i.qty.toLocaleString() + ' ' + i.unit + '</td>' +
      '<td style="color:var(--text-muted);font-size:11px">' + i.min.toLocaleString() + ' ' + i.unit + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + i.price.toLocaleString() + '원</td>' +
      '<td>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<span style="font-size:11px;font-weight:600;color:' + color + ';min-width:24px">' + level + '</span>' +
          '<div class="stock-bar" style="width:70px"><div class="stock-fill ' + fillCls + '" style="width:' + pct + '%"></div></div>' +
          '<span style="font-size:10px;color:var(--text-muted)">' + pct + '%</span>' +
        '</div>' +
      '</td>' +
      '<td>' +
        '<div class="btn-group">' +
          '<button class="btn btn-sm btn-outline" onclick="openStockInModal(\'' + i.code + '\')">입고</button>' +
          '<button class="btn btn-sm btn-ghost" onclick="openStockOutModal(\'' + i.code + '\')">출고</button>' +
          (i.qty < i.min ? '<button class="btn btn-sm btn-danger" onclick="openOrderModal(\'' + i.code + '\')">긴급발주</button>' : '<button class="btn btn-sm btn-ghost" onclick="openOrderModal(\'' + i.code + '\')">발주</button>') +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">📦 재고 관리</div>' +
      '<div class="btn-group">' +
        '<input class="form-control" id="inv-search" placeholder="품명/코드 검색" style="width:180px" ' +
          'oninput="document.getElementById(\'screen-inventory\')._filterTxt=this.value;renderInventory(document.getElementById(\'screen-inventory\'))">' +
        '<select class="form-control" style="width:auto" onchange="document.getElementById(\'screen-inventory\')._filterCat=this.value;renderInventory(document.getElementById(\'screen-inventory\'))">' +
          '<option value="">전체</option><option value="약품">약품</option><option value="수술재료">수술재료</option><option value="소모품">소모품</option>' +
        '</select>' +
        '<button class="btn btn-primary" onclick="openAddInventoryModal()">+ 품목 등록</button>' +
        '<button class="btn btn-outline" onclick="renderStockHistory(document.getElementById(\'screen-inventory\'))">📋 입출고 이력</button>' +
      '</div>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">전체 품목</div><div class="stat-value">' + DB.inventory.length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">재고 부족</div><div class="stat-value">' + lowStock.length + '</div>' + (lowStock.length>0?'<div class="stat-sub">즉시 발주 필요</div>':'') + '</div>' +
      '<div class="stat-card orange"><div class="stat-label">재고 주의</div><div class="stat-value">' + warnStock.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">발주 진행중</div><div class="stat-value">' + pendOrders.length + '</div></div>' +
    '</div>' +
    (lowStock.length>0?
      '<div style="background:#ffebee;border:1.5px solid #ef9a9a;border-radius:8px;padding:12px 14px;margin-bottom:12px">' +
        '<strong style="color:#b71c1c">🚨 재고 부족 ' + lowStock.length + '품목 — 즉시 발주 필요</strong><br>' +
        '<span style="font-size:11px;color:#c62828">' + lowStock.map(function(i){return i.name+'('+i.qty+i.unit+')';}).join(', ') + '</span>' +
      '</div>' : '') +
    '<div class="card">' +
      '<div class="tbl-wrap"><table>' +
        '<thead><tr><th>코드</th><th>품명</th><th>분류</th><th>현재고</th><th>안전재고</th><th>단가</th><th>재고상태</th><th>관리</th></tr></thead>' +
        '<tbody>' + (inv.length===0?'<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">품목 없음</td></tr>':inv.map(invRow).join('')) + '</tbody>' +
      '</table></div>' +
    '</div>';
}

// ─── 재고 입고 ─────────────────────────────────────────────
function openStockInModal(code) {
  var item = DB.inventory.find(function(i){return i.code===code;});
  if(!item) return;
  openDynamicModal('modal-stock-in',
    '<div class="modal-title">📥 재고 입고 — ' + item.name + '</div>',
    '<div style="background:#f8fafd;border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px">' +
      '<strong>' + item.name + '</strong> | 현재고: <strong style="color:' + (item.qty<item.min?'var(--danger)':'var(--success)') + '">' + item.qty + ' ' + item.unit + '</strong> | 안전재고: ' + item.min + ' ' + item.unit +
    '</div>' +
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 입고 수량</label><input class="form-control" type="number" id="in-qty" min="1" placeholder="수량 입력"></div>' +
      '<div class="form-group"><label>단가 (원)</label><input class="form-control" type="number" id="in-price" value="' + item.price + '"></div>' +
      '<div class="form-group"><label>공급업체</label><input class="form-control" id="in-vendor" placeholder="공급업체명"></div>' +
      '<div class="form-group"><label>입고일</label><input class="form-control" type="date" id="in-date" value="' + new Date().toISOString().substring(0,10) + '"></div>' +
      '<div class="form-group" style="grid-column:span 2"><label>비고</label><input class="form-control" id="in-note" placeholder="발주번호, 로트번호 등"></div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-stock-in\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveStockIn(\'' + code + '\')">✓ 입고 처리</button>'
  );
}

function saveStockIn(code) {
  var item = DB.inventory.find(function(i){return i.code===code;});
  if(!item) return;
  var qty = parseInt(document.getElementById('in-qty').value)||0;
  if(qty<=0) { notify('입력 오류','수량을 입력하세요.','error'); return; }
  var oldQty = item.qty;
  item.qty += qty;
  if(document.getElementById('in-price').value) item.price = parseInt(document.getElementById('in-price').value)||item.price;
  DB.stockMovements = DB.stockMovements||[];
  DB.stockMovements.push({
    id:'SM-'+Date.now(), code:code, name:item.name, type:'in', qty:qty, unit:item.unit, price:item.price,
    reason:'입고', vendor:document.getElementById('in-vendor').value||'',
    date:document.getElementById('in-date').value||new Date().toISOString().substring(0,10),
    note:document.getElementById('in-note').value||'',
    createdAt:new Date().toISOString(), createdBy:SESSION.user?SESSION.user.id:'',
    beforeQty:oldQty, afterQty:item.qty,
  });
  DB.auditLog.push({time:new Date().toISOString(),action:'STOCK_IN',user:SESSION.user?SESSION.user.username:'-',code:code,qty:qty});
  document.getElementById('modal-stock-in').classList.remove('open');
  notify('입고 완료',''+item.name+' '+qty+item.unit+' 입고 처리 완료 (현재고: '+item.qty+item.unit+')','success');
  renderScreen('inventory');
}

// ─── 재고 출고 ─────────────────────────────────────────────
function openStockOutModal(code) {
  var item = DB.inventory.find(function(i){return i.code===code;});
  if(!item) return;
  openDynamicModal('modal-stock-out',
    '<div class="modal-title">📤 재고 출고 — ' + item.name + '</div>',
    '<div style="background:#f8fafd;border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px">' +
      '현재고: <strong style="color:' + (item.qty<item.min?'var(--danger)':'var(--success)') + '">' + item.qty + ' ' + item.unit + '</strong>' +
    '</div>' +
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 출고 수량</label><input class="form-control" type="number" id="out-qty" min="1" max="' + item.qty + '" placeholder="수량 입력"></div>' +
      '<div class="form-group"><label>* 출고 사유</label>' +
        '<select class="form-control" id="out-reason"><option>병동 불출</option><option>외래 처방</option><option>수술 사용</option><option>폐기</option><option>반납</option><option>기타</option></select>' +
      '</div>' +
      '<div class="form-group" style="grid-column:span 2"><label>비고</label><input class="form-control" id="out-note" placeholder="상세 내용"></div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-stock-out\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-warning" onclick="saveStockOut(\'' + code + '\')">✓ 출고 처리</button>'
  );
}

function saveStockOut(code) {
  var item = DB.inventory.find(function(i){return i.code===code;});
  if(!item) return;
  var qty = parseInt(document.getElementById('out-qty').value)||0;
  if(qty<=0) { notify('입력 오류','수량을 입력하세요.','error'); return; }
  if(qty>item.qty) { notify('재고 부족','현재고('+item.qty+item.unit+')보다 많은 수량을 출고할 수 없습니다.','error'); return; }
  var oldQty = item.qty;
  item.qty -= qty;
  DB.stockMovements = DB.stockMovements||[];
  DB.stockMovements.push({
    id:'SM-'+Date.now(), code:code, name:item.name, type:'out', qty:qty, unit:item.unit, price:item.price,
    reason:document.getElementById('out-reason').value||'출고',
    note:document.getElementById('out-note').value||'',
    createdAt:new Date().toISOString(), createdBy:SESSION.user?SESSION.user.id:'',
    beforeQty:oldQty, afterQty:item.qty,
  });
  if(item.qty < item.min) {
    DB.notifications.push({id:'NTF-'+Date.now(),type:'stock_low',level:'warning',
      message:item.name+' 재고 부족 ('+item.qty+item.unit+') — 발주 필요',time:new Date().toISOString(),read:false});
  }
  document.getElementById('modal-stock-out').classList.remove('open');
  notify('출고 완료',''+item.name+' '+qty+item.unit+' 출고 완료 (현재고: '+item.qty+item.unit+')','success');
  renderScreen('inventory');
}

// ─── 발주 ──────────────────────────────────────────────────
function openOrderModal(code) {
  var item = DB.inventory.find(function(i){return i.code===code;});
  if(!item) return;
  var suggestQty = Math.max(item.min*3-item.qty, item.min);
  openDynamicModal('modal-order',
    '<div class="modal-title">🛒 발주 등록 — ' + item.name + '</div>',
    '<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px">' +
      '현재고: <strong style="color:' + (item.qty<item.min?'var(--danger)':'inherit') + '">' + item.qty + item.unit + '</strong> | 안전재고: ' + item.min + item.unit + ' | 권장 발주량: <strong>' + suggestQty + item.unit + '</strong>' +
    '</div>' +
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 발주 수량</label><input class="form-control" type="number" id="ord-qty" value="' + suggestQty + '" min="1"></div>' +
      '<div class="form-group"><label>* 공급업체</label><input class="form-control" id="ord-vendor" placeholder="공급업체명"></div>' +
      '<div class="form-group"><label>희망 납품일</label><input class="form-control" type="date" id="ord-date" value="' + new Date(Date.now()+7*86400000).toISOString().substring(0,10) + '"></div>' +
      '<div class="form-group"><label>예상 단가</label><input class="form-control" type="number" id="ord-price" value="' + item.price + '"></div>' +
      '<div class="form-group" style="grid-column:span 2"><label>비고</label><input class="form-control" id="ord-note" placeholder="특이사항"></div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-order\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveOrder(\'' + code + '\')">✓ 발주 등록</button>'
  );
}

function saveOrder(code) {
  var item = DB.inventory.find(function(i){return i.code===code;});
  if(!item) return;
  var qty = parseInt(document.getElementById('ord-qty').value)||0;
  if(qty<=0) { notify('입력 오류','발주 수량을 입력하세요.','error'); return; }
  var vendor = document.getElementById('ord-vendor').value||'-';
  if(vendor==='-') { notify('입력 오류','공급업체를 입력하세요.','error'); return; }
  
  var orderId = 'ORD-'+new Date().getFullYear()+'-'+String((DB.orders||[]).length+1).padStart(4,'0');
  DB.orders = DB.orders||[];
  DB.orders.push({
    id:orderId, code:code, name:item.name, qty:qty, unit:item.unit,
    price:parseInt(document.getElementById('ord-price').value)||item.price,
    vendor:vendor,
    expectedDate:document.getElementById('ord-date').value||'',
    note:document.getElementById('ord-note').value||'',
    status:'ordered', orderedAt:new Date().toISOString(),
    orderedBy:SESSION.user?SESSION.user.id:'', receivedAt:null,
    contactInfo:'', contactMethod:'phone', contactStatus:'pending'
  });
  
  // 공급업체 연락 알림 생성
  DB.notifications.push({
    id:'NTF-'+Date.now(),
    type:'order_placed',
    level:'info',
    message:'새 발주 등록: '+item.name+' '+qty+item.unit+' — '+vendor+' 연락 대기중',
    time:new Date().toISOString(),
    read:false,
    relId:orderId
  });
  updateNotifBadge();
  
  DB.auditLog.push({time:new Date().toISOString(),action:'ORDER_PLACED',user:SESSION.user?SESSION.user.username:'-',orderId:orderId,code:code,qty:qty,vendor:vendor});
  document.getElementById('modal-order').classList.remove('open');
  notify('발주 등록',''+orderId+' — '+item.name+' '+qty+item.unit+' 발주 완료<br><small>발주 현황에서 공급업체 연락을 완료 처리하세요.</small>','success');
  renderScreen('inventory');
}

// ─── 품목 추가 ─────────────────────────────────────────────
function openAddInventoryModal() {
  openDynamicModal('modal-add-inv',
    '<div class="modal-title">+ 재고 품목 등록</div>',
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 코드</label><input class="form-control" id="ni-code" placeholder="예: D005"></div>' +
      '<div class="form-group"><label>* 분류</label>' +
        '<select class="form-control" id="ni-cat"><option value="약품">약품</option><option value="수술재료">수술재료</option><option value="소모품">소모품</option></select>' +
      '</div>' +
      '<div class="form-group" style="grid-column:span 2"><label>* 품명</label><input class="form-control" id="ni-name" placeholder="품명 입력"></div>' +
      '<div class="form-group"><label>* 초기 재고</label><input class="form-control" type="number" id="ni-qty" value="0" min="0"></div>' +
      '<div class="form-group"><label>* 안전재고</label><input class="form-control" type="number" id="ni-min" value="10" min="1"></div>' +
      '<div class="form-group"><label>* 단위</label><input class="form-control" id="ni-unit" placeholder="정/EA/set 등"></div>' +
      '<div class="form-group"><label>* 단가 (원)</label><input class="form-control" type="number" id="ni-price" value="0"></div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-add-inv\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveNewInventory()">✓ 등록</button>'
  );
}

function saveNewInventory() {
  var code = document.getElementById('ni-code').value.trim().toUpperCase();
  var name = document.getElementById('ni-name').value.trim();
  if(!code||!name) { notify('입력 오류','코드와 품명을 입력하세요.','error'); return; }
  if(DB.inventory.find(function(i){return i.code===code;})) { notify('중복','이미 존재하는 코드입니다.','error'); return; }
  var qty = parseInt(document.getElementById('ni-qty').value)||0;
  DB.inventory.push({
    code:code, name:name,
    category:document.getElementById('ni-cat').value||'소모품',
    qty:qty, min:parseInt(document.getElementById('ni-min').value)||10,
    unit:document.getElementById('ni-unit').value||'EA',
    price:parseInt(document.getElementById('ni-price').value)||0,
  });
  if(qty>0) {
    DB.stockMovements = DB.stockMovements||[];
    DB.stockMovements.push({id:'SM-'+Date.now(),code:code,name:name,type:'in',qty:qty,
      reason:'초기 재고 등록',createdAt:new Date().toISOString(),createdBy:SESSION.user?SESSION.user.id:'',
      beforeQty:0,afterQty:qty});
  }
  document.getElementById('modal-add-inv').classList.remove('open');
  notify('등록 완료',name+' 품목이 등록되었습니다.','success');
  renderScreen('inventory');
}

// ─── 입출고 이력 ────────────────────────────────────────────
function renderStockHistory(el) {
  var moves = (DB.stockMovements||[]).slice().reverse().slice(0,50);
  var orders = (DB.orders||[]).slice().reverse().slice(0,20);
  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">📋 재고 입출고 이력</div>' +
      '<button class="btn btn-outline" onclick="renderInventory(document.getElementById(\'screen-inventory\'))">← 재고 목록으로</button>' +
    '</div>' +
    '<div class="grid-2" style="gap:14px">' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">입출고 기록 (최근 50건)</div></div>' +
        '<div class="tbl-wrap"><table style="font-size:11px">' +
          '<thead><tr><th>일시</th><th>품명</th><th>구분</th><th>수량</th><th>사유</th><th>담당</th></tr></thead>' +
          '<tbody>' + (moves.length===0
            ? '<tr><td colspan="6" style="text-align:center;padding:14px;color:var(--text-muted)">기록 없음</td></tr>'
            : moves.map(function(m){
                var typeLabel={in:'입고',out:'출고',use:'수술사용'}[m.type]||m.type;
                var typeColor={in:'var(--success)',out:'var(--warning)',use:'var(--primary)'}[m.type]||'inherit';
                return '<tr><td style="font-family:var(--mono)">'+(m.createdAt||'').substring(0,16).replace('T',' ')+'</td>' +
                  '<td>'+m.name+'</td>' +
                  '<td><span style="font-weight:600;color:'+typeColor+'">'+typeLabel+'</span></td>' +
                  '<td style="font-weight:700">'+(m.type==='out'||m.type==='use'?'-':'+')+''+m.qty+' '+(m.unit||'')+'</td>' +
                  '<td style="color:var(--text-muted)">'+m.reason+'</td>' +
                  '<td style="font-size:10px;color:var(--text-muted)">'+(DB.users.find(function(u){return u.id===m.createdBy;})||{}).name||m.createdBy||'-'+'</td></tr>';
              }).join('')) +
          '</tbody></table></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">발주 현황</div></div>' +
        '<div class="tbl-wrap"><table style="font-size:11px">' +
          '<thead><tr><th>발주번호</th><th>품명</th><th>수량</th><th>업체</th><th>연락상태</th><th>상태</th><th>관리</th></tr></thead>' +
          '<tbody>' + (orders.length===0
            ? '<tr><td colspan="7" style="text-align:center;padding:14px;color:var(--text-muted)">발주 없음</td></tr>'
            : orders.map(function(o){
                var contactBadge = o.contactStatus==='contacted' ? '<span class="badge badge-done">연락완료</span>' : '<span class="badge badge-waiting">연락대기</span>';
                var contactBtn = o.contactStatus!=='contacted' ? '<button class="btn btn-sm btn-outline" onclick="contactVendor(\''+o.id+'\')" style="margin-right:4px">연락완료</button>' : '';
                return '<tr><td style="font-family:var(--mono);font-size:10px">'+o.id+'</td>' +
                  '<td>'+o.name+'</td>' +
                  '<td>'+o.qty+' '+o.unit+'</td>' +
                  '<td style="color:var(--text-muted)">'+o.vendor+'</td>' +
                  '<td>'+contactBadge+'</td>' +
                  '<td><span class="badge '+(o.status==='received'?'badge-done':o.status==='ordered'?'badge-progress':'badge-waiting')+'">'+({ordered:'발주완료',pending:'대기',received:'입고완료'}[o.status]||o.status)+'</span></td>' +
                  '<td>'+(o.status!=='received'?contactBtn+'<button class="btn btn-sm btn-primary" onclick="receiveOrder(\''+o.id+'\')">입고처리</button>':'<span style="color:var(--success);font-size:11px">✓</span>')+'</td></tr>';
              }).join('')) +
          '</tbody></table></div>' +
      '</div>' +
    '</div>';
}

function receiveOrder(orderId) {
  var order = (DB.orders||[]).find(function(o){return o.id===orderId;});
  if(!order) return;
  var item = DB.inventory.find(function(i){return i.code===order.code;});
  if(!item) return;
  var oldQty = item.qty;
  item.qty += order.qty;
  order.status = 'received';
  order.receivedAt = new Date().toISOString();
  DB.stockMovements = DB.stockMovements||[];
  DB.stockMovements.push({
    id:'SM-'+Date.now(),code:order.code,name:order.name,type:'in',qty:order.qty,
    unit:order.unit,price:order.price,reason:'발주 입고 ('+orderId+')',vendor:order.vendor,
    createdAt:new Date().toISOString(),createdBy:SESSION.user?SESSION.user.id:'',
    beforeQty:oldQty,afterQty:item.qty,
  });
  notify('입고 처리',''+order.name+' '+order.qty+order.unit+' 입고 완료 (현재고: '+item.qty+order.unit+')','success');
  renderStockHistory(document.getElementById('screen-inventory'));
}

function contactVendor(orderId) {
  var order = (DB.orders||[]).find(function(o){return o.id===orderId;});
  if(!order) return;
  order.contactStatus = 'contacted';
  order.contactedAt = new Date().toISOString();
  
  // 연락 완료 알림 생성
  DB.notifications.push({
    id:'NTF-'+Date.now(),
    type:'order_contacted',
    level:'success',
    message:'공급업체 연락 완료: '+order.name+' — '+order.vendor+' (납품 대기중)',
    time:new Date().toISOString(),
    read:false,
    relId:orderId
  });
  updateNotifBadge();
  
  DB.auditLog.push({time:new Date().toISOString(),action:'VENDOR_CONTACTED',user:SESSION.user?SESSION.user.username:'-',orderId:orderId,vendor:order.vendor});
  notify('연락 완료',''+order.vendor+' 공급업체에 연락 완료<br><small>납품 예정일: '+(order.expectedDate||'미정')+'</small>','success');
  renderScreen('inventory');
}


function renderClaim(el) {
  var today = new Date();
  var thisMonth = today.getFullYear() + '-' + ('0'+(today.getMonth()+1)).slice(-2);
  var pays = DB.payments || [];
  var totalCases = pays.filter(function(p){return p.status==='완료';}).length;
  var totalAmt   = pays.filter(function(p){return p.status==='완료';}).reduce(function(a,p){return a+(p.amount||0);},0);
  var claimData  = DB.claimData || {};
  var deletions  = claimData.deletions || [];
  var appeals    = claimData.appeals   || [];

  function delRow(d) {
    return '<tr>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (d.id||'-') + '</td>' +
      '<td>' + (d.patient||d.pt||'-') + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (d.date||'-') + '</td>' +
      '<td style="font-size:11px">' + (d.item||'-') + '</td>' +
      '<td style="font-family:var(--mono)">₩' + ((d.amount||d.amt||0)).toLocaleString() + '</td>' +
      '<td style="font-size:11px;color:var(--danger)">' + (d.reason||'-') + '</td>' +
      '<td>' + (d.canAppeal?'<button class="btn btn-sm btn-outline" onclick="notify(\'이의신청\',\'이의신청서를 작성합니다.\',\'info\')">이의신청</button>':'<span style="color:var(--text-muted);font-size:11px">-</span>') + '</td>' +
    '</tr>';
  }

  el.innerHTML =
    '<div class="section-title">💰 심평원 청구 관리</div>' +
    '<div class="grid-2" style="margin-bottom:16px">' +

      // ── 청구 현황 카드 ──
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">📋 청구 현황</div></div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>청구 대상 년월</label>' +
            '<input class="form-control" type="month" id="claim-month" value="' + thisMonth + '"></div>' +
          '<div class="form-group"><label>보험 유형</label>' +
            '<select class="form-control"><option>건강보험</option><option>의료급여</option><option>자동차보험</option><option>산재보험</option></select></div>' +
        '</div>' +
        '<div class="edi-step done">' +
          '<div class="edi-step-num">✓</div>' +
          '<div class="edi-step-info"><div class="edi-step-title">1. 진료비 집계</div>' +
            '<div class="edi-step-sub">' + totalCases + '건 · ₩' + (totalAmt/10000).toFixed(0) + '만원 집계</div></div>' +
        '</div>' +
        '<div class="edi-step' + (totalCases>0?' done':'') + '">' +
          '<div class="edi-step-num">' + (totalCases>0?'✓':'2') + '</div>' +
          '<div class="edi-step-info"><div class="edi-step-title">2. 사전점검 (청구오류점검)</div>' +
            '<div class="edi-step-sub">' + (totalCases>0?'오류 0건 확인 완료':'수납 완료 후 진행') + '</div></div>' +
        '</div>' +
        '<div class="edi-step">' +
          '<div class="edi-step-num">3</div>' +
          '<div class="edi-step-info"><div class="edi-step-title">3. EDI 파일 생성 및 전송</div>' +
            '<div class="edi-step-sub">심평원 포털 연동 필요</div></div>' +
        '</div>' +
        '<div class="edi-step">' +
          '<div class="edi-step-num">4</div>' +
          '<div class="edi-step-info"><div class="edi-step-title">4. 심사 결과 수신</div>' +
            '<div class="edi-step-sub">전송 후 약 10일 소요</div></div>' +
        '</div>' +
        '<div style="margin-top:12px;display:flex;gap:8px">' +
          '<button class="btn btn-outline" onclick="notify(\'EDI\',\'EDI 파일 생성을 준비합니다.\',\'info\')">📋 EDI 파일 생성</button>' +
          '<button class="btn btn-primary" onclick="submitClaim()">🔄 청구 전송</button>' +
        '</div>' +
      '</div>' +

      // ── 삭감 내역 카드 ──
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">⚠ 삭감/불능 내역</div></div>' +
        (deletions.length>0?
          '<div class="claim-warn error" style="margin-bottom:8px">' +
            '<span class="claim-icon">🚫</span>' +
            '<div><strong>' + deletions.length + '건 삭감 — 총 ₩' +
              deletions.reduce(function(a,d){return a+(d.amount||d.amt||0);},0).toLocaleString() +
            '원</strong><br><span style="font-size:11px">이의신청 검토 필요</span></div>' +
          '</div>' :
          '<div style="text-align:center;padding:16px;color:var(--success)">✓ 삭감 없음</div>') +
        (deletions.length>0?
          '<table><thead><tr><th>번호</th><th>환자</th><th>날짜</th><th>항목</th><th>금액</th><th>사유</th><th>이의</th></tr></thead>' +
          '<tbody>' + deletions.map(delRow).join('') + '</tbody></table>' : '') +
      '</div>' +

    '</div>' +

    // ── 이의신청 현황 ──
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">📝 이의신청 현황</div>' +
        '<button class="btn btn-sm btn-primary" onclick="notify(\'이의신청\',\'이의신청서를 작성합니다.\',\'info\')">+ 이의신청 등록</button>' +
      '</div>' +
      (appeals.length===0?
        '<div style="text-align:center;padding:16px;color:var(--text-muted)">이의신청 내역 없음</div>' :
        '<table><thead><tr><th>번호</th><th>환자</th><th>진료월</th><th>항목</th><th>금액</th><th>신청일</th><th>상태</th><th>결과</th></tr></thead>' +
        '<tbody>' +
          appeals.map(function(a){
            return '<tr><td style="font-family:var(--mono);font-size:11px">' + (a.no||'-') + '</td>' +
              '<td>' + (a.pt||'-') + '</td>' +
              '<td style="font-family:var(--mono)">' + (a.month||'-') + '</td>' +
              '<td style="font-size:11px">' + (a.item||'-') + '</td>' +
              '<td style="font-family:var(--mono)">₩' + ((a.amt||0)).toLocaleString() + '</td>' +
              '<td style="font-family:var(--mono);font-size:11px">' + (a.date||'-') + '</td>' +
              '<td><span class="badge ' + (a.status==='완료'?'badge-done':'badge-progress') + '">' + (a.status||'검토중') + '</span></td>' +
              '<td style="font-size:11px">' + (a.result||'-') + '</td></tr>';
          }).join('') +
        '</tbody></table>') +
    '</div>';
}

function renderStats(el) {
  // DB에서 실시간 집계
  var totalPts   = DB.patientMaster.length;
  var totalCharts= DB.emrCharts.filter(function(c){return c.entryType==='original';}).length;
  var totalWard  = DB.wardPatients.length;
  var totalPay   = DB.payments ? DB.payments.reduce(function(a,p){return a+(p.amount||0);},0) : 0;
  var totalClaims= DB.prescriptions ? DB.prescriptions.length : 0;
  var delRate    = DB.claimData ? (DB.claimData.deletions||[]).reduce(function(a,d){return a+(d.amount||0);},0) : 0;

  // 진료과별 외래 집계 (emrCharts + patientMaster visitHistory 기반)
  var deptCounts = {};
  var deptColors = {ortho1:'#1a4fa0',ortho2:'#1565c0',neuro:'#4527a0',internal:'#00695c',anesthesia:'#6d4c41',health:'#00796b'};
  var deptNames  = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과·건강검진',anesthesia:'마취통증의학과',health:'건강검진'};
  DB.patientMaster.forEach(function(p){
    (p.visitHistory||[]).forEach(function(v){
      var d = v.dept||'기타';
      deptCounts[d] = (deptCounts[d]||0)+1;
    });
  });
  DB.emrCharts.filter(function(c){return c.entryType==='original';}).forEach(function(ch){
    var d = ch.dept||'기타';
    deptCounts[d] = (deptCounts[d]||0)+1;
  });
  var deptArr = Object.keys(deptCounts).sort(function(a,b){return deptCounts[b]-deptCounts[a];}).slice(0,6);
  var maxDept = deptArr.length>0 ? deptCounts[deptArr[0]] : 1;

  // 의사별 차트 수
  var drStats = {};
  DB.users.filter(function(u){return u.role.startsWith('doctor')||u.role==='hospital_director';}).forEach(function(u){
    var cnt = DB.emrCharts.filter(function(c){return c.lockedBy===u.id&&c.entryType==='original';}).length;
    drStats[u.id] = {name:u.name, dept:(deptNames[u.dept]||u.dept), cnt:cnt};
  });
  var drArr = Object.values(drStats).sort(function(a,b){return b.cnt-a.cnt;});

  // 상병코드 TOP 5
  var icdCounts = {};
  DB.emrCharts.filter(function(c){return c.entryType==='original'&&c.soap&&c.soap.A;}).forEach(function(ch){
    var icdList = ch.icd10||[];
    if(!Array.isArray(icdList) && ch.soap&&ch.soap.A){
      var m = ch.soap.A.match(/([A-Z]\d{2,3}\.?\d*)/g);
      if(m) icdList = m.map(function(code){return {code:code,name:ch.soap.A.substring(0,30)};});
    }
    icdList.forEach(function(icd){
      var key = (icd.code||icd)+' '+(icd.name||'');
      icdCounts[key] = (icdCounts[key]||0)+1;
    });
  });
  var icdArr = Object.entries(icdCounts).sort(function(a,b){return b[1]-a[1];}).slice(0,5);
  var icdColors = ['#1a4fa0','#00c896','#f57c00','#6a1b9a','#e53935'];

  // 신환/초진/재진 비율
  var typeCount = {신환:0,초진:0,재진:0};
  DB.patientMaster.forEach(function(p){
    (p.visitHistory||[]).forEach(function(v){
      if(v.visitType&&typeCount.hasOwnProperty(v.visitType)) typeCount[v.visitType]++;
    });
  });
  var totalType = typeCount.신환+typeCount.초진+typeCount.재진||1;
  var r재진 = Math.round(typeCount.재진/totalType*100);
  var r초진 = Math.round(typeCount.초진/totalType*100);
  var r신환 = 100-r재진-r초진;

  var deptBars = deptArr.length === 0
    ? '<div style="text-align:center;padding:20px;color:var(--text-muted)">진료 기록이 없습니다. 환자 접수 후 EMR 작성 시 자동 집계됩니다.</div>'
    : deptArr.map(function(d){
        var n = deptCounts[d]; var r = n/maxDept;
        return '<div style="margin-bottom:12px">' +
          '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">' +
            '<span><strong>' + (deptNames[d]||d) + '</strong></span>' +
            '<span style="color:var(--text-muted)">' + n + '건 (' + Math.round(r*100) + '%)</span>' +
          '</div>' +
          '<div style="height:12px;background:#f0f2f5;border-radius:6px;overflow:hidden">' +
            '<div style="height:100%;width:' + Math.round(r*100) + '%;background:' + (deptColors[d]||'var(--primary)') + ';border-radius:6px"></div>' +
          '</div></div>';
      }).join('');

  var drRows = drArr.length === 0
    ? '<tr><td colspan="3" style="text-align:center;padding:12px;color:var(--text-muted)">등록된 의사 없음</td></tr>'
    : drArr.map(function(d){
        return '<tr><td>' + d.name + '</td><td style="font-size:11px">' + d.dept + '</td>' +
          '<td style="font-weight:700">' + d.cnt + '건</td></tr>';
      }).join('');

  var icdRows = icdArr.length === 0
    ? '<div style="text-align:center;padding:12px;color:var(--text-muted)">상병 데이터 없음</div>'
    : icdArr.map(function(entry, i){
        var parts = entry[0].split(' ');
        var code = parts[0]; var name = parts.slice(1).join(' ').substring(0,20)||code;
        return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">' +
          '<div style="width:20px;height:20px;border-radius:50%;background:' + icdColors[i] + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;flex-shrink:0">' + (i+1) + '</div>' +
          '<div style="flex:1"><div style="font-size:11px;font-weight:600">' + name + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono)">' + code + '</div></div>' +
          '<div style="font-size:13px;font-weight:700">' + entry[1] + '</div></div>';
      }).join('');

  el.innerHTML =
    '<div class="section-title">📊 병원 통계</div>' +
    '<div class="form-row" style="margin-bottom:16px">' +
      '<div class="form-group"><label>기간</label>' +
        '<div style="display:flex;gap:6px">' +
          '<input class="form-control" type="date" id="stat-from" value="' + new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString().substring(0,10) + '">' +
          '<span style="align-self:center;color:var(--text-muted)">~</span>' +
          '<input class="form-control" type="date" id="stat-to" value="' + new Date().toISOString().substring(0,10) + '">' +
        '</div></div>' +
      '<button class="btn btn-primary" style="align-self:flex-end" onclick="renderStats(document.getElementById(\'screen-stats\'))">🔄 새로고침</button>' +
      '<button class="btn btn-outline" style="align-self:flex-end" onclick="notify(\'출력\',\'통계를 엑셀로 출력합니다.\',\'info\')\">📊 엑셀 출력</button>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:16px">' +
      '<div class="stat-card blue"><div class="stat-label">등록 환자수</div><div class="stat-value">' + totalPts + '</div><div class="stat-sub">누적 환자 마스터</div></div>' +
      '<div class="stat-card green"><div class="stat-label">EMR 차트 수</div><div class="stat-value">' + totalCharts + '</div><div class="stat-sub">완료 차트 기준</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">현재 입원 환자</div><div class="stat-value">' + totalWard + '</div><div class="stat-sub">현재 재원 환자</div></div>' +
      '<div class="stat-card red"><div class="stat-label">처방 건수</div><div class="stat-value">' + totalClaims + '</div><div class="stat-sub">외래 처방 누적</div></div>' +
    '</div>' +
    '<div class="grid-2" style="margin-bottom:16px">' +
      '<div class="card"><div class="card-header"><div class="card-title">📊 진료과별 외래 현황</div></div>' +
        '<div style="padding:8px 0">' + deptBars + '</div>' +
      '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">💰 수납 현황</div></div>' +
        '<div style="padding:12px">' +
          (function(){
            var pays = DB.payments||[];
            var completed = pays.filter(function(p){return p.status==='완료';});
            var pending   = pays.filter(function(p){return p.status==='미수';});
            var totalAmt  = completed.reduce(function(a,p){return a+(p.amount||0);},0);
            var pendingAmt= pending.reduce(function(a,p){return a+(p.amount||0);},0);
            var cashAmt   = completed.filter(function(p){return p.method==='현금';}).reduce(function(a,p){return a+(p.amount||0);},0);
            var cardAmt   = completed.filter(function(p){return p.method==='카드';}).reduce(function(a,p){return a+(p.amount||0);},0);
            if(pays.length===0) return '<div style="text-align:center;padding:20px;color:var(--text-muted)">수납 데이터 없음 — 수납 처리 후 자동 집계</div>';
            return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
              '<div style="text-align:center;padding:10px;background:#f0fdf4;border-radius:8px"><div style="font-size:11px;color:var(--text-muted)">완료 수납액</div><div style="font-size:18px;font-weight:700;color:var(--success)">₩' + (totalAmt/10000).toFixed(1) + 'M</div><div style="font-size:10px;color:var(--text-muted)">' + completed.length + '건</div></div>' +
              '<div style="text-align:center;padding:10px;background:#fff8e1;border-radius:8px"><div style="font-size:11px;color:var(--text-muted)">미수금</div><div style="font-size:18px;font-weight:700;color:var(--warning)">₩' + (pendingAmt/10000).toFixed(1) + 'M</div><div style="font-size:10px;color:var(--text-muted)">' + pending.length + '건</div></div>' +
              '<div style="text-align:center;padding:10px;background:#e3f2fd;border-radius:8px"><div style="font-size:11px;color:var(--text-muted)">현금</div><div style="font-size:16px;font-weight:700">₩' + (cashAmt/10000).toFixed(1) + 'M</div></div>' +
              '<div style="text-align:center;padding:10px;background:#ede7f6;border-radius:8px"><div style="font-size:11px;color:var(--text-muted)">카드</div><div style="font-size:16px;font-weight:700">₩' + (cardAmt/10000).toFixed(1) + 'M</div></div>' +
            '</div>';
          })() +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="grid-3">' +
      '<div class="card"><div class="card-header"><div class="card-title">🏥 신환/초진/재진 비율</div></div>' +
        '<div style="text-align:center;padding:12px">' +
          '<div style="display:flex;justify-content:center;gap:20px;margin-top:8px">' +
            '<div><div style="width:14px;height:14px;border-radius:50%;background:#1a4fa0;display:inline-block;margin-right:6px"></div><span style="font-size:12px">재진 ' + r재진 + '%</span></div>' +
            '<div><div style="width:14px;height:14px;border-radius:50%;background:#00c896;display:inline-block;margin-right:6px"></div><span style="font-size:12px">초진 ' + r초진 + '%</span></div>' +
            '<div><div style="width:14px;height:14px;border-radius:50%;background:#f57c00;display:inline-block;margin-right:6px"></div><span style="font-size:12px">신환 ' + r신환 + '%</span></div>' +
          '</div>' +
          '<div style="width:140px;height:140px;border-radius:50%;background:conic-gradient(#1a4fa0 0% ' + r재진 + '%, #00c896 ' + r재진 + '% ' + (r재진+r초진) + '%, #f57c00 ' + (r재진+r초진) + '% 100%);margin:16px auto"></div>' +
          (totalType<=1?'<div style="font-size:11px;color:var(--text-muted);margin-top:8px">환자 방문 데이터 없음</div>':'') +
        '</div>' +
      '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">📋 주요 상병 TOP 5</div></div>' +
        '<div style="padding:0 4px">' + icdRows + '</div>' +
      '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">👤 의사별 진료 현황</div></div>' +
        '<table><thead><tr><th>의사명</th><th>진료과</th><th>차트수</th></tr></thead>' +
        '<tbody>' + drRows + '</tbody></table>' +
      '</div>' +
    '</div>';
}

function renderPatients(el) {
  el.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div class="section-title" style="margin:0">👥 환자 관리 <small style="font-size:11px;font-weight:400;color:var(--text-muted)">— 전체 등록 환자 DB (과거 내원 포함)</small></div>
    <div class="btn-group">
      <input class="form-control" id="pt-search-input" placeholder="이름/등록번호/생년월일 검색" style="width:240px" oninput="filterPatientList(this.value)">
      <button class="btn btn-primary" onclick="openModal('modal-reception')">+ 신규 등록</button>
      <button class="btn btn-outline">📊 엑셀 출력</button>
    </div>
  </div>
  <div class="card">
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>등록번호</th><th>환자명</th><th>성별/나이</th><th>보험</th><th>현재 담당의</th><th>최근진료일</th><th>총내원</th><th>인수인계</th><th>관리</th></tr></thead>
        <tbody id="patient-table-body">
          ${renderPatientRows(DB.patientMaster)}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderPatientRows(patients) {
  return patients.map(function(p) {
    const lastVisit = p.visitHistory.length > 0 ? p.visitHistory[p.visitHistory.length-1] : null;
    const lastDate = lastVisit ? lastVisit.date : '-';
    const visitCount = p.visitHistory.length;

    // 현재 담당의 표시
    const currentDr = p.currentDoctorName ||
      (lastVisit ? (DB.users.find(function(u){ return u.id===lastVisit.doctor; })||{}).name || lastVisit.doctor : '-');
    const isHandedOver = !!p.currentDoctor && p.currentDoctor !== (lastVisit && lastVisit.doctor);

    // 인수인계 이력 확인
    const handoverAdm = DB.emrCharts.filter(function(c){
      return c.ptId === p.pid && c.entryType === 'addendum' && c.isHandoverRecord;
    });

    return '<tr>' +
      '<td style="font-family:var(--mono);font-size:11px;color:var(--primary)">' + p.pid + '</td>' +
      '<td><strong>' + p.name + '</strong><br><small style="color:var(--text-muted)">' + p.phone + '</small></td>' +
      '<td>' + p.gender + ' · ' + calcAge(p.dob) + '세</td>' +
      '<td style="font-size:11px">' + p.insurance + '</td>' +
      '<td>' +
        '<div style="font-size:12px;font-weight:600">' + currentDr + '</div>' +
        (isHandedOver ? '<div style="font-size:10px;color:var(--warning)">⇄ 인수인계됨</div>' : '') +
      '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + lastDate + '</td>' +
      '<td style="font-weight:700;text-align:center">' + visitCount + '회</td>' +
      '<td>' + (handoverAdm.length > 0
        ? '<span class="badge badge-warning" style="font-size:9px;cursor:pointer" onclick="showHandoverDetail(\'' + p.pid + '\')" title="클릭하여 인수인계 내역 확인">⇄ ' + handoverAdm.length + '건</span>'
        : '<span style="color:var(--text-muted);font-size:10px">-</span>') +
      '</td>' +
      '<td><div class="btn-group">' +
        '<button class="btn btn-sm btn-outline" onclick="openEMR(\'' + p.pid + '\')">진료기록</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="showPatientHistory(\'' + p.pid + '\')">이력</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

function filterPatientList(q) {
  const tbody = document.getElementById('patient-table-body');
  if(!tbody) return;
  if(!q) { tbody.innerHTML = renderPatientRows(DB.patientMaster); return; }
  const filtered = DB.patientMaster.filter(function(p) {
    return p.name.includes(q) || p.pid.includes(q) || p.dob.includes(q) || p.phone.includes(q);
  });
  tbody.innerHTML = filtered.length > 0
    ? renderPatientRows(filtered)
    : '<tr><td colspan="9" style="text-align:center;padding:16px;color:var(--text-muted)">검색 결과 없음</td></tr>';
}

function showHandoverDetail(pid) {
  const patient = DB.patientMaster.find(function(p){ return p.pid === pid; });
  if(!patient) return;
  const addenda = DB.emrCharts.filter(function(c){
    return c.ptId === pid && c.entryType === 'addendum' && c.isHandoverRecord;
  });
  if(addenda.length === 0) { notify('인수인계','인수인계 기록 없음','info'); return; }
  const detail = addenda.map(function(a) {
    return '• ' + new Date(a.lockedAt).toLocaleDateString('ko-KR') + ': ' + a.addendumReason;
  }).join('\n');
  alert('[' + patient.name + '] 인수인계 내역\n\n' + detail);
}

function renderHealth(el) {
  el.innerHTML = `
  <div class="section-title">🔬 건강검진센터</div>
  <div class="grid-4" style="margin-bottom:16px">
    <div class="stat-card blue"><div class="stat-label">오늘 검진</div><div class="stat-value">8</div></div>
    <div class="stat-card green"><div class="stat-label">결과 완료</div><div class="stat-value">${(DB.prescriptions||[]).filter(function(p){return p.status==="waiting"||p.status==="dur_check";}).length}</div></div>
    <div class="stat-card orange"><div class="stat-label">판독 대기</div><div class="stat-value">${(DB.labResults||[]).filter(function(l){return l.status==="critical";}).length}</div></div>
    <div class="stat-card red"><div class="stat-label">이상소견</div><div class="stat-value">2</div></div>
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">검진 현황</div><button class="btn btn-sm btn-primary">+ 검진 등록</button></div>
    <table>
      <thead><tr><th>순번</th><th>환자명</th><th>검진유형</th><th>진행상태</th><th>이상소견</th><th>판독의</th><th>관리</th></tr></thead>
      <tbody>
        ${[
          ...(function(){var ch=(DB.reservations||[]).filter(function(r){return r.dept==='health'&&r.date===new Date().toISOString().substring(0,10);});return ch.map(function(r,i){return {no:i+1,name:r.patient||'-',type:r.checkupType||'건강검진',status:r.status||'대기',flag:false,dr:'정원석 원장'};});})(),
        ].map(r => `<tr>
          <td>${r.no}</td>
          <td><strong>${r.name}</strong></td>
          <td>${r.type}</td>
          <td><span class="badge ${r.status==='완료'?'badge-done':r.status==='검진중'?'badge-progress':'badge-waiting'}">${r.status}</span></td>
          <td>${r.flag ? '<span class="badge badge-urgent">⚠ 이상소견</span>' : '<span style="color:var(--success);font-size:11px">✓ 정상</span>'}</td>
          <td>${r.dr}</td>
          <td><button class="btn btn-sm btn-outline">결과지</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

// 자동 업데이트 초기화 및 정기 체크
function initMealAutoUpdate() {
  // 초기 업데이트
  autoUpdateMealMenuFromWeeklyPlan();
  
  // 마지막 업데이트 일자 저장
  SESSION.lastMealUpdateDate = new Date().toISOString().substring(0,10);
  
  // 매 5분마다 자정 통과 여부 체크
  if(!SESSION.mealAutoUpdateInterval) {
    SESSION.mealAutoUpdateInterval = setInterval(function(){
      var now = new Date().toISOString().substring(0,10);
      // 새로운 날짜가 되었으면 자동 업데이트
      if(SESSION.lastMealUpdateDate !== now) {
        autoUpdateMealMenuFromWeeklyPlan();
        SESSION.lastMealUpdateDate = now;
        // 현재 식단 화면이 보여지면 새로고침
        if(SESSION.currentScreen === 'meal') {
          renderScreen('meal');
        }
      }
    }, 5*60*1000); // 5분마다 체크
  }
}

// 주간 식단을 오늘의 기본 메뉴로 자동 업데이트
function autoUpdateMealMenuFromWeeklyPlan() {
  var today = new Date();
  var todayKey = today.toISOString().substring(0,10);
  if(!DB.weeklyMealPlan) DB.weeklyMealPlan = {};
  if(!DB.mealMenu) DB.mealMenu = {};
  
  var todayPlan = DB.weeklyMealPlan[todayKey];
  if(todayPlan && Object.keys(todayPlan).length > 0) {
    // 주간 식단에 오늘 데이터가 있으면 메인 메뉴로 업데이트
    ['breakfast','lunch','dinner'].forEach(function(meal){
      if(todayPlan[meal] && Object.keys(todayPlan[meal]).length > 0) {
        DB.mealMenu[meal] = todayPlan[meal];
      }
    });
  }
}

function renderMeal(el) {
  // 주간 식단에서 오늘 식단 자동 반영
  autoUpdateMealMenuFromWeeklyPlan();
  
  var today = new Date();
  var todayStr = today.toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
  var todayKey = today.toISOString().substring(0,10);
  var dow = today.getDay(); // 0=일
  if(!DB.mealMenu) DB.mealMenu = {};
  if(!DB.mealOrders) DB.mealOrders = {};
  if(!DB.weeklyMealPlan) DB.weeklyMealPlan = {};

  // 오늘 식단 통계
  var wards = DB.wardPatients || [];
  var dietCounts = {normal:0, diabetic:0, soft:0, lowsalt:0, npo:0};
  wards.forEach(function(wp) {
    var orders = DB.mealOrders[wp.bed] || {};
    var dt = (orders.breakfast||{}).dietType || wp.dietBreakfast || 'normal';
    if(dietCounts[dt]!==undefined) dietCounts[dt]++;
    else dietCounts.normal++;
  });

  var MENU_DATA = DB.mealMenu;
  var defaultMenu = {
    breakfast:{ normal:['쌀밥','된장국','계란말이','김치','멸치볶음'], diabetic:['현미밥','두부미역국','계란찜','나물'], soft:['쌀죽','호박국','두부조림'], lowsalt:['쌀밥','저염국','계란찜','나물'], npo:['금식'] },
    lunch:    { normal:['잡곡밥','미역국','닭볶음','시금치','깍두기'], diabetic:['현미밥','저염미역국','닭가슴살','채소볶음'], soft:['잡곡죽','맑은국','연두부','단호박'], lowsalt:['잡곡밥','저염국','두부조림','나물'], npo:['금식'] },
    dinner:   { normal:['쌀밥','콩나물국','생선구이','감자조림','김치'], diabetic:['현미밥','저염국','생선찜','채소쌈'], soft:['흰죽','맑은국','으깬감자','요거트'], lowsalt:['쌀밥','저염콩나물국','생선구이','채소'], npo:['금식'] },
  };
  ['breakfast','lunch','dinner'].forEach(function(m){
    if(!MENU_DATA[m]) MENU_DATA[m] = defaultMenu[m];
  });

  // 주간 식단 (이번 주 월~일)
  var weekDays = ['일','월','화','수','목','금','토'];
  var monday = new Date(today);
  monday.setDate(today.getDate() - (dow===0?6:dow-1));
  var weekDates = [];
  for(var i=0;i<7;i++){
    var d = new Date(monday);
    d.setDate(monday.getDate()+i);
    weekDates.push({
      key: d.toISOString().substring(0,10),
      label: weekDays[d.getDay()]+'('+d.getDate()+')',
      isToday: d.toISOString().substring(0,10)===todayKey,
      isSun: d.getDay()===0,
    });
  }

  function mealCard(mealKey, mealLabel, timeTxt, bg) {
    var menu = MENU_DATA[mealKey] || defaultMenu[mealKey] || {};
    var todayPlan = (DB.weeklyMealPlan[todayKey]||{})[mealKey] || {};
    return '<div class="card" style="background:'+bg+';margin-bottom:10px">' +
      '<div class="card-header" style="background:rgba(0,0,0,0.04)">' +
        '<div class="card-title">'+mealLabel+' <small style="font-size:11px;color:var(--text-muted);font-weight:400">'+timeTxt+'</small></div>' +
        '<div class="btn-group">' +
          '<button class="btn btn-sm btn-ghost" onclick="openMealMenuEditor(\''+mealKey+'\',\'normal\')">✏ 일반식 편집</button>' +
          '<button class="btn btn-sm btn-outline" onclick="openTodayPlanModal(\''+mealKey+'\')">📋 오늘 메뉴 등록</button>' +
        '</div>' +
      '</div>' +
      '<div style="padding:6px 0">' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
          ['normal','diabetic','soft','lowsalt'].map(function(dt){
            var dtLabel={normal:'일반식',diabetic:'당뇨식',soft:'연식',lowsalt:'저염식'}[dt];
            var items = (todayPlan[dt]||(MENU_DATA[mealKey]||{})[dt]||defaultMenu[mealKey][dt]||[]);
            var cnt = 0;
            wards.forEach(function(wp){
              var o=(DB.mealOrders[wp.bed]||{})[mealKey]||{};
              if((o.dietType||'normal')===dt) cnt++;
            });
            return '<div style="min-width:130px;flex:1">' +
              '<div style="font-size:10px;font-weight:700;color:var(--text-muted);margin-bottom:4px">'+dtLabel+' ('+cnt+'명)</div>' +
              '<div style="font-size:11px;line-height:1.8">' + items.slice(0,5).join('<br>') + '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // 주간 식단표
  function weeklyTable() {
    return '<div class="card" style="margin-top:16px">' +
      '<div class="card-header">' +
        '<div class="card-title">📅 주간 식단표</div>' +
        '<button class="btn btn-sm btn-primary" onclick="openWeeklyPlanModal()">+ 주간 식단 등록</button>' +
      '</div>' +
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">' +
        '<thead><tr style="background:#f8f9fa">' +
          '<th style="padding:8px 10px;text-align:left;min-width:70px">끼니</th>' +
          weekDates.map(function(d){
            return '<th style="padding:8px 10px;text-align:center;min-width:90px;'+(d.isToday?'background:#e3f2fd;font-weight:800':'')+'">' +
              d.label + (d.isToday?' ★':'') + '</th>';
          }).join('') +
        '</tr></thead>' +
        '<tbody>' +
          ['breakfast','lunch','dinner'].map(function(mealKey){
            var ml = {breakfast:'🌅 아침',lunch:'☀ 점심',dinner:'🌙 저녁'}[mealKey];
            return '<tr style="border-top:1px solid #f0f0f0"><td style="padding:7px 10px;font-weight:700">'+ml+'</td>' +
              weekDates.map(function(d){
                var plan = (DB.weeklyMealPlan[d.key]||{})[mealKey] || {};
                var items = (plan.normal||(MENU_DATA[mealKey]||{}).normal||defaultMenu[mealKey].normal||[]);
                return '<td style="padding:6px 8px;text-align:center;'+(d.isToday?'background:#f0f7ff':'')+'">' +
                  (items.length>0 ? '<div style="font-size:10px;color:var(--text-muted)">'+items.slice(0,2).join(', ')+(items.length>2?'...':'')+
                      '</div><button class="btn btn-sm btn-ghost" style="font-size:9px;padding:2px 5px;margin-top:2px" onclick="openDayMealModal(\''+d.key+'\',\''+mealKey+'\')">편집</button>' :
                    '<button class="btn btn-sm btn-ghost" style="font-size:10px" onclick="openDayMealModal(\''+d.key+'\',\''+mealKey+'\')">+ 등록</button>') +
                  '</td>';
              }).join('') +
            '</tr>';
          }).join('') +
        '</tbody></table></div>' +
    '</div>';
  }

  // 환자별 식단 카드
  var ptMealHtml = wards.length===0
    ? '<div style="text-align:center;padding:20px;color:var(--text-muted)">입원 환자 없음</div>'
    : wards.map(function(wp){
        var key = wp.bed.replace(/[^a-z0-9]/gi,'_');
        var orders = DB.mealOrders[wp.bed] || {};
        var companion = (orders.breakfast||{}).companion || wp.companionMeal || 0;
        return '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
            '<div><strong>'+wp.bed+'</strong> '+wp.name+' <small style="color:var(--text-muted)">'+wp.doctor+'</small></div>' +
            '<div class="btn-group">' +
              '<button class="btn btn-sm btn-ghost" onclick="copyMealAll(\''+wp.bed+'\')">전체 동일</button>' +
              '<button class="btn btn-sm btn-outline" onclick="saveMealOrder(\''+wp.bed+'\')">저장</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' +
            ['breakfast','lunch','dinner'].map(function(meal){
              var mLabel={breakfast:'🌅 아침',lunch:'☀ 점심',dinner:'🌙 저녁'}[meal];
              var cur=(orders[meal]||{}).dietType||(meal==='breakfast'?wp.dietBreakfast:meal==='lunch'?wp.dietLunch:wp.dietDinner)||'normal';
              var preview = ((MENU_DATA[meal]||{})[cur]||defaultMenu[meal][cur]||[]).slice(0,2).join(', ');
              return '<div style="background:#f8fafd;border-radius:6px;padding:8px">' +
                '<div style="font-size:10px;font-weight:700;margin-bottom:4px">'+mLabel+'</div>' +
                '<select class="form-control" id="diet-'+meal+'-'+key+'" style="font-size:11px;margin-bottom:4px" ' +
                  'onchange="updateMealPreview(\''+wp.bed+'\',\''+meal+'\',this.value)">' +
                  ['normal','diabetic','soft','lowsalt','npo'].map(function(dt){
                    var dl={normal:'일반식',diabetic:'당뇨식',soft:'연식',lowsalt:'저염식',npo:'금식'};
                    return '<option value="'+dt+'"'+(cur===dt?' selected':'')+'>'+dl[dt]+'</option>';
                  }).join('') +
                '</select>' +
                '<div id="preview-'+meal+'-'+key+'" style="font-size:10px;color:var(--text-muted)">'+preview+'</div>' +
                '<div style="display:flex;align-items:center;gap:6px;margin-top:4px">' +
                  '<label style="font-size:10px;white-space:nowrap">보호자식</label>' +
                  '<select class="form-control" id="companion-'+meal+'-'+key+'" style="font-size:10px;padding:2px 4px">' +
                    [0,1,2,3].map(function(n){return '<option value="'+n+'"'+(companion===n?' selected':'')+'>'+n+'식</option>';}).join('') +
                  '</select>' +
                '</div>' +
              '</div>';
            }).join('') +
          '</div>' +
          (orders.breakfast&&orders.breakfast.note?'<div style="font-size:11px;color:var(--text-muted);margin-top:6px">📝 '+orders.breakfast.note+'</div>':'') +
        '</div>';
      }).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">🍽 식단 관리 — '+todayStr+'</div>' +
      '<div class="btn-group">' +
        '<button class="btn btn-outline" onclick="printMealOrder()">🖨 배식표 출력</button>' +
        '<button class="btn btn-primary" onclick="saveAllMealOrders()">✓ 전체 저장</button>' +
      '</div>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">일반식</div><div class="stat-value">'+dietCounts.normal+'명</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">당뇨식</div><div class="stat-value">'+dietCounts.diabetic+'명</div></div>' +
      '<div class="stat-card" style="border-top:3px solid #6a1b9a"><div class="stat-label">연식</div><div class="stat-value">'+dietCounts.soft+'명</div></div>' +
      '<div class="stat-card red"><div class="stat-label">저염/금식</div><div class="stat-value">'+(dietCounts.lowsalt+dietCounts.npo)+'명</div></div>' +
    '</div>' +
    '<div class="grid-3" style="margin-bottom:16px">' +
      mealCard('breakfast','🌅 아침','07:30 배식','#fffde7') +
      mealCard('lunch','☀ 점심','12:00 배식','#e3f2fd') +
      mealCard('dinner','🌙 저녁','18:00 배식','#f3e5f5') +
    '</div>' +
    weeklyTable() +
    '<div class="card" style="margin-top:16px">' +
      '<div class="card-header"><div class="card-title">👥 환자별 식단 처방</div>' +
        '<button class="btn btn-sm btn-outline" onclick="saveAllMealOrders()">전체 저장</button>' +
      '</div>' +
      ptMealHtml +
    '</div>';
}

function openTodayMealEditor() {
  // 오늘 메뉴 전체 편집 (아침/점심/저녁 × 식단 종류)
  var today = new Date().toISOString().substring(0,10);
  openWeeklyPlanModal(today);
}

function openTodayPlanModal(mealKey) {
  openDayMealModal(new Date().toISOString().substring(0,10), mealKey);
}

function openDayMealModal(dateKey, mealKey) {
  var mealLabel = {breakfast:'아침',lunch:'점심',dinner:'저녁'}[mealKey]||mealKey;
  var date = new Date(dateKey);
  var dateLabel = dateKey + ' ' + ['일','월','화','수','목','금','토'][date.getDay()]+'요일';
  if(!DB.weeklyMealPlan) DB.weeklyMealPlan = {};
  if(!DB.weeklyMealPlan[dateKey]) DB.weeklyMealPlan[dateKey] = {};
  var existing = DB.weeklyMealPlan[dateKey][mealKey] || {};
  var MENU_DATA = DB.mealMenu || {};
  var defaultMenu = {
    breakfast:{ normal:['쌀밥','된장국','계란말이','김치','멸치볶음'], diabetic:['현미밥','두부미역국','계란찜','나물'], soft:['쌀죽','호박국','두부조림'], lowsalt:['쌀밥','저염국','계란찜','나물'], npo:['금식'] },
    lunch:    { normal:['잡곡밥','미역국','닭볶음','시금치','깍두기'], diabetic:['현미밥','저염미역국','닭가슴살','채소'], soft:['잡곡죽','맑은국','연두부'], lowsalt:['잡곡밥','저염국','두부조림','나물'], npo:['금식'] },
    dinner:   { normal:['쌀밥','콩나물국','생선구이','감자조림','김치'], diabetic:['현미밥','저염국','생선찜','채소'], soft:['흰죽','맑은국','으깬감자'], lowsalt:['쌀밥','저염콩나물국','생선구이','채소'], npo:['금식'] },
  };

  var bodyHtml = '<div style="font-size:12px;color:var(--primary);margin-bottom:12px">'+dateLabel+' '+mealLabel+'</div>' +
    ['normal','diabetic','soft','lowsalt','npo'].map(function(dt){
      var dtLabel={normal:'일반식',diabetic:'당뇨식',soft:'연식',lowsalt:'저염식',npo:'금식'}[dt];
      var items = existing[dt] || (MENU_DATA[mealKey]||{})[dt] || (defaultMenu[mealKey]||{})[dt] || [];
      return '<div class="form-group">' +
        '<label style="font-weight:700">'+dtLabel+'</label>' +
        '<textarea class="form-control" id="daymeal-'+dt+'" style="min-height:70px;font-size:11px" placeholder="메뉴를 줄바꿈으로 구분 입력">'+items.join('\n')+'</textarea>' +
      '</div>';
    }).join('');

  openDynamicModal('modal-day-meal',
    '<div class="modal-title">📋 식단 등록 — '+mealLabel+' ('+dateLabel+')</div>',
    bodyHtml,
    '<button class="btn btn-ghost" onclick="closeDayMealAndReturnToWeekly()">취소</button>' +
    '<button class="btn btn-primary" onclick="saveDayMeal(\''+dateKey+'\',\''+mealKey+'\')">✓ 저장</button>'
  );
}

function closeDayMealAndReturnToWeekly() {
  document.getElementById('modal-day-meal').classList.remove('open');
  var weekOffset = SESSION.weeklyMealWeekOffset || 0;
  setTimeout(function(){
    openWeeklyPlanModal(null, weekOffset);
  }, 200);
}

function saveDayMeal(dateKey, mealKey) {
  if(!DB.weeklyMealPlan) DB.weeklyMealPlan = {};
  if(!DB.weeklyMealPlan[dateKey]) DB.weeklyMealPlan[dateKey] = {};
  var plan = {};
  ['normal','diabetic','soft','lowsalt','npo'].forEach(function(dt){
    var ta = document.getElementById('daymeal-'+dt);
    if(ta) plan[dt] = ta.value.split('\n').map(function(s){return s.trim();}).filter(Boolean);
  });
  DB.weeklyMealPlan[dateKey][mealKey] = plan;
  document.getElementById('modal-day-meal').classList.remove('open');
  notify('저장', dateKey+' '+mealKey+' 식단이 저장되었습니다.', 'success');
  
  // 주간 식단 모달로 돌아가기
  var weekOffset = SESSION.weeklyMealWeekOffset || 0;
  setTimeout(function(){
    openWeeklyPlanModal(null, weekOffset);
  }, 300);
}

function openWeeklyPlanModal(focusDate, weekOffset) {
  weekOffset = weekOffset || 0; // 0=이번주, 1=다음주, -1=지난주
  SESSION.weeklyMealWeekOffset = weekOffset; // 저장 후 돌아올 때 사용
  
  var today = new Date().toISOString().substring(0,10);
  var target = focusDate || today;
  
  // 주 단위 오프셋 적용
  var baseDate = new Date(target);
  baseDate.setDate(baseDate.getDate() + (weekOffset * 7));
  
  // 해당 주의 월요일 구하기
  var dow = baseDate.getDay();
  var monday = new Date(baseDate);
  monday.setDate(baseDate.getDate() - (dow===0?6:dow-1));
  
  var weekDates = [];
  for(var i=0;i<7;i++){
    var d2 = new Date(monday);
    d2.setDate(monday.getDate()+i);
    weekDates.push(d2.toISOString().substring(0,10));
  }
  
  var weekDays = ['일','월','화','수','목','금','토'];
  var mondayLabel = new Date(weekDates[0]);
  var sundayLabel = new Date(weekDates[6]);
  var weekRange = (mondayLabel.getMonth()+1)+'/'+mondayLabel.getDate() + ' ~ ' + (sundayLabel.getMonth()+1)+'/'+sundayLabel.getDate();
  
  var bodyHtml =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<div style="font-size:12px;font-weight:700;color:var(--primary)">'+weekRange+'</div>' +
      '<div class="btn-group">' +
        (weekOffset > 0 ? '<button class="btn btn-sm btn-ghost" onclick="openWeeklyPlanModal(null,'+(weekOffset-1)+')">← 이전 주</button>' : '') +
        (weekOffset === 0 ? '<button class="btn btn-sm btn-primary" onclick="openWeeklyPlanModal(null,1)">다음 주 →</button>' : '<button class="btn btn-sm btn-primary" onclick="openWeeklyPlanModal(null,0)">← 이번 주</button>') +
      '</div>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">날짜를 선택해 각 끼니 메뉴를 등록하세요</div>' +
    '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:8px">' +
      weekDates.map(function(d){
        var dd = new Date(d);
        var isToday = d===today;
        var hasPlan = DB.weeklyMealPlan && DB.weeklyMealPlan[d] && Object.keys(DB.weeklyMealPlan[d]).length>0;
        return '<button onclick="document.getElementById(\'modal-week-plan\').classList.remove(\'open\');openDayMealModal(\''+d+'\',\'breakfast\')" ' +
          'style="padding:6px 4px;border-radius:6px;border:1.5px solid '+(isToday?'var(--primary)':'var(--border)')+';' +
                 'background:'+(isToday?'var(--primary)':hasPlan?'#e8f5e9':'#fff')+';' +
                 'color:'+(isToday?'#fff':'inherit')+';cursor:pointer;font-size:11px;text-align:center">' +
          weekDays[dd.getDay()]+'<br><span style="font-weight:700">'+dd.getDate()+'</span>' +
          (hasPlan?'<br><span style="font-size:9px">✓</span>':'') +
        '</button>';
      }).join('') +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-muted)">✓ 표시 = 등록됨 | 날짜 클릭 → 끼니별 편집</div>';

  openDynamicModal('modal-week-plan',
    '<div class="modal-title">📅 주간 식단 등록 ' + (weekOffset === 0 ? '(이번 주)' : weekOffset === 1 ? '(다음 주)' : '(지난 주)') + '</div>',
    bodyHtml,
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-week-plan\').classList.remove(\'open\')">닫기</button>'
  );
}



function openMealMenuEditor(meal, dietType) {
  var menuData = (DB.mealMenu && DB.mealMenu[meal] && DB.mealMenu[meal][dietType]) || [];
  var mealLabel = {breakfast:'아침',lunch:'점심',dinner:'저녁'}[meal]||meal;
  var dietLabel = {normal:'일반식',diabetic:'당뇨식',soft:'연식',lowsalt:'저염식',npo:'금식'}[dietType]||dietType;

  openDynamicModal('modal-meal-edit',
    '<div class="modal-title">🍽 식단 편집 — ' + mealLabel + ' ' + dietLabel + '</div>',
    '<div class="form-group">' +
      '<label>메뉴 항목 (줄바꿈으로 구분)</label>' +
      '<textarea class="form-control" id="meal-edit-items" style="min-height:140px;font-family:var(--font)">' +
        menuData.join('\n') +
      '</textarea>' +
      '<div style="font-size:10px;color:var(--text-muted);margin-top:4px">각 줄에 메뉴 1개씩 입력 (예: 쌀밥)</div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-meal-edit\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveMealMenuEdit(\'' + meal + '\',\'' + dietType + '\')">✓ 저장</button>'
  );
}

function saveMealMenuEdit(meal, dietType) {
  var ta = document.getElementById('meal-edit-items');
  if(!ta) return;
  var items = ta.value.split('\n').map(function(s){return s.trim();}).filter(function(s){return s;});
  if(!DB.mealMenu) DB.mealMenu = {};
  if(!DB.mealMenu[meal]) DB.mealMenu[meal] = {};
  DB.mealMenu[meal][dietType] = items;
  
  // 오늘 메뉴를 수정하면 weeklyMealPlan도 함께 업데이트
  var today = new Date().toISOString().substring(0,10);
  if(!DB.weeklyMealPlan) DB.weeklyMealPlan = {};
  if(!DB.weeklyMealPlan[today]) DB.weeklyMealPlan[today] = {};
  if(!DB.weeklyMealPlan[today][meal]) DB.weeklyMealPlan[today][meal] = {};
  DB.weeklyMealPlan[today][meal][dietType] = items;
  
  document.getElementById('modal-meal-edit').classList.remove('open');
  notify('저장 완료', meal + ' ' + dietType + ' 메뉴가 저장되었습니다.', 'success');
  renderScreen('meal');
}


function updateMealPreview(bed, meal, dietType) {
  var MEAL_MENU_DATA = DB.mealMenu || {};
  const key = bed.replace(/[^a-z0-9]/gi,'_');
  const el = document.getElementById('preview-' + meal + '-' + key);
  if (el) el.textContent = (MEAL_MENU_DATA[meal][dietType]||[]).slice(0,3).join(' · ');
  if (DB.mealOrders[bed]) DB.mealOrders[bed][meal].dietType = dietType;
}

function saveMealOrder(bed) {
  const key = bed.replace(/[^a-z0-9]/gi,'_');
  if (!DB.mealOrders[bed]) DB.mealOrders[bed] = { breakfast:{}, lunch:{}, dinner:{} };
  ['breakfast','lunch','dinner'].forEach(function(meal) {
    const dietEl = document.getElementById('diet-' + meal + '-' + key);
    const compEl = document.getElementById('companion-' + meal + '-' + key);
    if (dietEl) DB.mealOrders[bed][meal].dietType = dietEl.value;
    if (compEl) DB.mealOrders[bed][meal].companion = parseInt(compEl.value) || 0;
  });
  const noteEl = document.getElementById('note-' + key);
  if (noteEl) ['breakfast','lunch','dinner'].forEach(m => DB.mealOrders[bed][m].note = noteEl.value);
  notify('저장 완료', bed + ' 식단이 저장되었습니다.', 'success');
}

function saveAllMealOrders() {
  DB.wardPatients.forEach(wp => saveMealOrder(wp.bed));
  notify('전체 저장', '모든 환자 식단이 저장되었습니다.', 'success');
}

function copyMealAll(bed) {
  const key = bed.replace(/[^a-z0-9]/gi,'_');
  const breakfastDiet = document.getElementById('diet-breakfast-' + key);
  if (!breakfastDiet) return;
  const diet = breakfastDiet.value;
  ['lunch','dinner'].forEach(function(meal) {
    const el = document.getElementById('diet-' + meal + '-' + key);
    if (el) { el.value = diet; updateMealPreview(bed, meal, diet); }
  });
  notify('복사 완료', bed + ' 모든 끼니를 동일 식단으로 설정했습니다.', 'info');
}

function printMealOrder() { notify('출력', '오늘 배식표를 출력합니다.', 'info'); }

function renderNonsurg(el) {
  var procs = (DB.ptSchedules||[]).filter(function(p){ return p.type === 'nonsurg'; });
  var done  = procs.filter(function(p){ return p.status === 'completed'; });
  var wait  = procs.filter(function(p){ return p.status === 'waiting'; });
  var prog  = procs.filter(function(p){ return p.status === 'in_progress'; });

  function procRow(r, i) {
    return '<tr>' +
      '<td>' + (i+1) + '</td>' +
      '<td><strong>' + r.ptName + '</strong></td>' +
      '<td style="font-size:11px">' + (r.treatType||'-') + '</td>' +
      '<td>' + (r.doctor||'-') + '</td>' +
      '<td>' + (r.site||'-') + '</td>' +
      '<td><span class="badge ' + (r.covered?'badge-done':'badge-waiting') + '">' + (r.covered?'급여':'비급여') + '</span></td>' +
      '<td><span class="badge ' + (r.status==='completed'?'badge-done':r.status==='in_progress'?'badge-progress':'badge-waiting') + '">' +
        (r.status==='completed'?'완료':r.status==='in_progress'?'시술중':'대기') + '</span></td>' +
      '<td><button class="btn btn-sm btn-primary" onclick="completePTSession(\'' + r.id + '\')">완료</button></td>' +
    '</tr>';
  }

  var listHtml = procs.length === 0
    ? '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">오늘 시술 없음<br><br><button class="btn btn-primary" onclick="openAddNonsurgModal()">+ 시술 등록</button></td></tr>'
    : procs.map(procRow).join('');

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">💉 비수술치료센터</div>' +
      '<button class="btn btn-primary" onclick="openAddNonsurgModal()">+ 시술 등록</button>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:14px">' +
      '<div class="stat-card blue"><div class="stat-label">오늘 시술</div><div class="stat-value">' + procs.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">완료</div><div class="stat-value">' + done.length + '</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">대기</div><div class="stat-value">' + wait.length + '</div></div>' +
      '<div class="stat-card red"><div class="stat-label">진행중</div><div class="stat-value">' + prog.length + '</div></div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">시술 현황</div>' +
        '<button class="btn btn-sm btn-primary" onclick="openAddNonsurgModal()">+ 시술 등록</button>' +
      '</div>' +
      '<table><thead><tr><th>순번</th><th>환자명</th><th>시술명</th><th>처방의</th><th>시술부위</th><th>급/비급여</th><th>상태</th><th>관리</th></tr></thead>' +
      '<tbody>' + listHtml + '</tbody></table>' +
    '</div>';
}

// ─── FINANCE SCREEN ─────────────────────────────────────
function renderFinance(el) {
  var pays    = DB.payments || [];
  var done    = pays.filter(function(p){ return p.status==='완료'; });
  var unpaid  = pays.filter(function(p){ return p.status==='미수'; });
  var refunds = pays.filter(function(p){ return p.status==='환불'; });
  var revenue = done.reduce(function(a,p){ return a+(p.amount||0); }, 0);
  var unpaidAmt= unpaid.reduce(function(a,p){ return a+(p.amount||0); }, 0);
  var refundAmt= refunds.reduce(function(a,p){ return a+(p.amount||0); }, 0);
  var costAmt = (DB.stockMovements||[]).filter(function(m){ return m.type==='out'||m.type==='use'; })
                .reduce(function(a,m){ return a+(m.qty*(m.price||0)); }, 0);

  // 발주 내역 (매입)
  var orderRows = (DB.orders||[]).slice().reverse().slice(0,10).map(function(o){
    return '<tr>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (o.orderedAt||'').substring(0,10) + '</td>' +
      '<td>' + (o.vendor||'-') + '</td>' +
      '<td style="font-size:11px">' + o.name + ' x' + o.qty + o.unit + '</td>' +
      '<td style="font-family:var(--mono)">₩' + ((o.qty*(o.price||0))).toLocaleString() + '</td>' +
      '<td style="font-size:11px">₩' + Math.round((o.qty*(o.price||0))*0.1).toLocaleString() + '</td>' +
      '<td><span class="badge badge-info">매입</span></td>' +
      '<td><span class="badge ' + (o.status==='received'?'badge-done':'badge-waiting') + '">' +
        (o.status==='received'?'승인':'처리중') + '</span></td>' +
    '</tr>';
  });

  // 수납 내역 (매출)
  var payRows = done.slice().reverse().slice(0,5).map(function(p){
    return '<tr>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (p.paidAt||p.issuedAt||'').substring(0,10) + '</td>' +
      '<td>' + (p.ptName||'-') + '</td>' +
      '<td style="font-size:11px">진료비</td>' +
      '<td style="font-family:var(--mono)">₩' + (p.amount||0).toLocaleString() + '</td>' +
      '<td style="font-family:var(--mono)">₩' + Math.round((p.amount||0)*0).toLocaleString() + '</td>' +
      '<td><span class="badge badge-done">매출</span></td>' +
      '<td><span class="badge badge-done">승인</span></td>' +
    '</tr>';
  });

  var allRows = orderRows.concat(payRows);

  el.innerHTML =
    '<div class="section-title">💵 재무 관리</div>' +
    '<div class="grid-4" style="margin-bottom:16px">' +
      '<div class="stat-card green" onclick="renderScreen(\'payment\')" style="cursor:pointer">' +
        '<div class="stat-label">총 수납액</div>' +
        '<div class="stat-value">₩' + (revenue/10000).toFixed(1) + 'M</div>' +
        '<div class="stat-sub">완료 ' + done.length + '건</div>' +
      '</div>' +
      '<div class="stat-card red">' +
        '<div class="stat-label">재료비 지출</div>' +
        '<div class="stat-value">₩' + (costAmt/10000).toFixed(1) + 'M</div>' +
        '<div class="stat-sub">입출고 기반</div>' +
      '</div>' +
      '<div class="stat-card blue">' +
        '<div class="stat-label">순수익 (추정)</div>' +
        '<div class="stat-value">₩' + ((revenue-costAmt)/10000).toFixed(1) + 'M</div>' +
        '<div class="stat-sub">수납 - 재료비</div>' +
      '</div>' +
      '<div class="stat-card orange" onclick="renderScreen(\'payment\')" style="cursor:pointer">' +
        '<div class="stat-label">미수금</div>' +
        '<div class="stat-value">₩' + (unpaidAmt/10000).toFixed(1) + 'M</div>' +
        '<div class="stat-sub">' + unpaid.length + '건</div>' +
      '</div>' +
    '</div>' +
    '<div class="grid-2" style="margin-bottom:16px">' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">💳 수납 현황</div>' +
          '<button class="btn btn-sm btn-outline" onclick="renderScreen(\'payment\')">전체 보기</button>' +
        '</div>' +
        (done.length===0?
          '<div style="text-align:center;padding:20px;color:var(--text-muted)">수납 데이터 없음</div>' :
          '<div class="tbl-wrap"><table style="font-size:11px"><thead><tr><th>일자</th><th>환자</th><th>금액</th><th>방법</th><th>상태</th></tr></thead><tbody>' +
          done.slice().reverse().slice(0,8).map(function(p){
            return '<tr><td style="font-family:var(--mono)">' + (p.paidAt||'').substring(0,10) + '</td>' +
              '<td>' + p.ptName + '</td>' +
              '<td style="font-family:var(--mono)">₩' + (p.amount||0).toLocaleString() + '</td>' +
              '<td>' + (p.method||'-') + '</td>' +
              '<td><span class="badge badge-done">완료</span></td></tr>';
          }).join('') +
          '</tbody></table></div>') +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div class="card-title">📦 발주/지출 현황</div>' +
          '<button class="btn btn-sm btn-outline" onclick="renderScreen(\'inventory\')">재고 관리</button>' +
        '</div>' +
        ((DB.orders||[]).length===0?
          '<div style="text-align:center;padding:20px;color:var(--text-muted)">발주 데이터 없음</div>' :
          '<div class="tbl-wrap"><table style="font-size:11px"><thead><tr><th>일자</th><th>품목</th><th>금액</th><th>상태</th></tr></thead><tbody>' +
          (DB.orders||[]).slice().reverse().slice(0,8).map(function(o){
            return '<tr><td style="font-family:var(--mono)">' + (o.orderedAt||'').substring(0,10) + '</td>' +
              '<td>' + o.name + '</td>' +
              '<td style="font-family:var(--mono)">₩' + (o.qty*(o.price||0)).toLocaleString() + '</td>' +
              '<td><span class="badge ' + (o.status==='received'?'badge-done':'badge-waiting') + '">' +
                (o.status==='received'?'입고완료':'진행중') + '</span></td></tr>';
          }).join('') +
          '</tbody></table></div>') +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">🧾 세금계산서 내역</div></div>' +
      (allRows.length===0?
        '<div style="text-align:center;padding:20px;color:var(--text-muted)">세금계산서 데이터 없음 — 발주 및 수납 처리 시 자동 집계</div>' :
        '<div class="tbl-wrap"><table><thead><tr><th>일자</th><th>거래처</th><th>내용</th><th>공급가액</th><th>세액</th><th>구분</th><th>상태</th></tr></thead>' +
        '<tbody>' + allRows.join('') + '</tbody></table></div>') +
    '</div>';
}

// ─── CLAIM MANAGEMENT SCREEN ─────────────────────────────
function renderClaimMgmt(el) {
  var pays = DB.payments || [];
  var done = pays.filter(function(p){return p.status==='완료';});
  var totalAmt = done.reduce(function(a,p){return a+(p.amount||0);},0);
  var deletions = (DB.claimData&&DB.claimData.deletions)||[];
  var appeals   = (DB.claimData&&DB.claimData.appeals)||[];
  var delAmt    = deletions.reduce(function(a,d){return a+(d.amount||d.amt||0);},0);
  var delRate   = totalAmt>0 ? (delAmt/totalAmt*100).toFixed(2) : '0.00';

  el.innerHTML =
    '<div class="section-title">🏥 심사청구 관리</div>' +
    '<div class="grid-4" style="margin-bottom:16px">' +
      '<div class="stat-card blue"><div class="stat-label">이번달 청구 건수</div>' +
        '<div class="stat-value">' + done.length + '</div>' +
        '<div class="stat-sub">수납 완료 기준</div></div>' +
      '<div class="stat-card green"><div class="stat-label">청구 총액</div>' +
        '<div class="stat-value" style="font-size:20px">₩' + (totalAmt/10000).toFixed(1) + 'M</div>' +
        '<div class="stat-sub">수납 완료 합계</div></div>' +
      '<div class="stat-card red"><div class="stat-label">삭감·불능</div>' +
        '<div class="stat-value">' + (delAmt>0?'₩'+delAmt.toLocaleString():'없음') + '</div>' +
        '<div class="stat-sub">' + deletions.length + '건 | 이의 ' + appeals.length + '건</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">삭감률</div>' +
        '<div class="stat-value">' + delRate + '%</div>' +
        '<div class="stat-sub">' + (parseFloat(delRate)<1.2?'양호':'주의 필요') + '</div></div>' +
    '</div>' +
    '<div class="tabs" id="claim-tabs">' +
      '<div class="tab active" onclick="switchClaimTab(\'worklist\',this)">📋 청구 워크리스트</div>' +
      '<div class="tab" onclick="switchClaimTab(\'edi\',this)">📤 EDI 전송</div>' +
      '<div class="tab" onclick="switchClaimTab(\'review\',this)">🔍 심사 현황</div>' +
      '<div class="tab" onclick="switchClaimTab(\'deletion\',this)">⚠ 삭감·불능</div>' +
      '<div class="tab" onclick="switchClaimTab(\'appeal\',this)">📝 이의신청</div>' +
      '<div class="tab" onclick="switchClaimTab(\'precheck\',this)">✅ 사전점검</div>' +
    '</div>' +
    '<div id="claim-tab-content"></div>';

  switchClaimTab('worklist', el.querySelector('.tab'));
}

function switchClaimTab(tab, el) {
  document.querySelectorAll('#claim-tabs .tab').forEach(function(t){t.classList.remove('active');});
  if(el) el.classList.add('active');
  var content = document.getElementById('claim-tab-content');
  if(!content) return;
  var pays = DB.payments || [];
  var done = pays.filter(function(p){return p.status==='완료';});
  var deletions = (DB.claimData&&DB.claimData.deletions)||[];
  var appeals   = (DB.claimData&&DB.claimData.appeals)||[];

  if(tab==='worklist') {
    var rows = done.length===0
      ? '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">수납 완료 내역 없음 — 수납 처리 후 자동 집계됩니다</td></tr>'
      : done.slice().reverse().map(function(p){
          return '<tr>' +
            '<td style="font-family:var(--mono);font-size:11px">' + (p.paidAt||p.issuedAt||'').substring(0,10) + '</td>' +
            '<td><strong>' + (p.ptName||'-') + '</strong></td>' +
            '<td style="font-family:var(--mono);font-size:11px">' + (p.ptId||'-') + '</td>' +
            '<td>' + (p.insuranceType||'건강보험') + '</td>' +
            '<td>' + (p.dept?({ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과'}[p.dept]||p.dept):'-') + '</td>' +
            '<td style="font-family:var(--mono)">₩' + (p.amount||0).toLocaleString() + '</td>' +
            '<td style="font-family:var(--mono)">₩' + (p.amount||0).toLocaleString() + '</td>' +
            '<td><span class="badge badge-done">청구예정</span></td>' +
          '</tr>';
        }).join('');
    content.innerHTML =
      '<div class="card" style="margin-top:12px">' +
        '<div class="card-header"><div class="card-title">이번달 청구 대상 목록</div>' +
          '<div class="btn-group">' +
            '<select class="form-control" style="width:auto;font-size:11px">' +
              '<option>전체</option><option>건강보험</option><option>의료급여</option><option>자동차보험</option>' +
            '</select>' +
            '<button class="btn btn-sm btn-outline" onclick="notify(\'출력\',\'청구 목록을 출력합니다.\',\'info\')">📊 엑셀 출력</button>' +
          '</div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>방문일</th><th>환자명</th><th>등록번호</th><th>보험</th><th>진료과</th><th>진료비</th><th>청구액</th><th>상태</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
      '</div>';

  } else if(tab==='edi') {
    content.innerHTML =
      '<div class="card" style="margin-top:12px">' +
        '<div class="card-header"><div class="card-title">📤 EDI 전송 관리</div></div>' +
        '<div style="padding:8px 0;font-size:12px;color:#1565c0;margin-bottom:12px">' +
          '<strong>심평원 EDI 전송 프로세스:</strong> 진료비 집계 → 사전점검 → EDI 생성 → 전송 → 결과수신' +
        '</div>' +
        '<div class="form-row" style="margin-bottom:12px">' +
          '<div class="form-group"><label>청구 년월</label><input class="form-control" type="month" id="edi-month" value="' + new Date().toISOString().substring(0,7) + '"></div>' +
          '<div class="form-group"><label>보험 유형</label><select class="form-control"><option>건강보험</option><option>의료급여</option><option>자동차보험</option><option>산재보험</option></select></div>' +
        '</div>' +
        ['진료비 집계','사전점검 (청구오류점검)','EDI 파일 생성','심평원 서버 전송'].map(function(t,i){
          var n = i+1;
          return '<div class="edi-step pending"><div class="edi-step-num">'+n+'</div>' +
            '<div class="edi-step-info"><div class="edi-step-title">'+n+'. '+t+'</div>' +
            '<div class="edi-step-sub">준비 중 — 이전 단계 완료 후 진행</div></div></div>';
        }).join('') +
        '<div style="margin-top:14px;display:flex;gap:8px">' +
          '<button class="btn btn-outline" onclick="notify(\'집계\',\'이번달 진료비를 집계합니다.\',\'info\')">1. 진료비 집계</button>' +
          '<button class="btn btn-primary" onclick="submitClaim()">📤 EDI 전송 시작</button>' +
        '</div>' +
      '</div>';

  } else if(tab==='deletion') {
    var delRows = deletions.length===0
      ? '<tr><td colspan="7" style="text-align:center;padding:16px;color:var(--success)">✓ 삭감 내역 없음</td></tr>'
      : deletions.map(function(d){
          return '<tr>' +
            '<td style="font-family:var(--mono);font-size:11px">' + (d.id||'-') + '</td>' +
            '<td>' + (d.patient||d.pt||'-') + '</td>' +
            '<td style="font-family:var(--mono);font-size:11px">' + (d.date||'-') + '</td>' +
            '<td style="font-size:11px">' + (d.item||'-') + '</td>' +
            '<td style="font-family:var(--mono)">₩' + (d.amount||d.amt||0).toLocaleString() + '</td>' +
            '<td style="font-size:11px;color:var(--danger)">' + (d.reason||'-') + '</td>' +
            '<td>' + (d.canAppeal?'<button class="btn btn-sm btn-outline" onclick="notify(\'이의신청\',\'이의신청서를 작성합니다.\',\'info\')">이의신청</button>':'-') + '</td>' +
          '</tr>';
        }).join('');
    content.innerHTML =
      '<div class="card" style="margin-top:12px">' +
        '<div class="card-header"><div class="card-title">⚠ 삭감·불능 내역</div></div>' +
        '<table><thead><tr><th>번호</th><th>환자</th><th>날짜</th><th>항목</th><th>금액</th><th>사유</th><th>이의</th></tr></thead>' +
        '<tbody>' + delRows + '</tbody></table>' +
      '</div>';

  } else if(tab==='appeal') {
    var appRows = appeals.length===0
      ? '<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--text-muted)">이의신청 내역 없음</td></tr>'
      : appeals.map(function(a){
          return '<tr>' +
            '<td style="font-family:var(--mono);font-size:11px">' + (a.no||'-') + '</td>' +
            '<td>' + (a.pt||'-') + '</td>' +
            '<td style="font-family:var(--mono)">' + (a.month||'-') + '</td>' +
            '<td style="font-size:11px">' + (a.item||'-') + '</td>' +
            '<td style="font-family:var(--mono)">₩' + (a.amt||0).toLocaleString() + '</td>' +
            '<td style="font-family:var(--mono);font-size:11px">' + (a.date||'-') + '</td>' +
            '<td><span class="badge ' + (a.status==='완료'?'badge-done':'badge-progress') + '">' + (a.status||'검토중') + '</span></td>' +
            '<td style="font-size:11px">' + (a.result||'-') + '</td>' +
          '</tr>';
        }).join('');
    content.innerHTML =
      '<div class="card" style="margin-top:12px">' +
        '<div class="card-header"><div class="card-title">📝 이의신청 현황</div>' +
          '<button class="btn btn-sm btn-primary" onclick="notify(\'이의신청\',\'이의신청 양식을 작성합니다.\',\'info\')">+ 이의신청 등록</button>' +
        '</div>' +
        '<table><thead><tr><th>번호</th><th>환자</th><th>진료월</th><th>항목</th><th>금액</th><th>신청일</th><th>상태</th><th>결과</th></tr></thead>' +
        '<tbody>' + appRows + '</tbody></table>' +
      '</div>';

  } else if(tab==='precheck') {
    var issues = done.filter(function(p){return !p.icd10||!p.amount;}).length;
    content.innerHTML =
      '<div class="card" style="margin-top:12px">' +
        '<div class="card-header"><div class="card-title">✅ 청구 사전점검</div>' +
          '<button class="btn btn-sm btn-primary" onclick="notify(\'점검\',\'사전점검을 시작합니다.\',\'info\')">▶ 점검 실행</button>' +
        '</div>' +
        '<div style="padding:16px">' +
          (done.length===0
            ? '<div style="text-align:center;color:var(--text-muted)">청구 대상 데이터 없음</div>'
            : '<div style="background:' + (issues===0?'#e8f5e9':'#fff8e1') + ';border-radius:8px;padding:12px 14px">' +
                (issues===0
                  ? '<span style="color:var(--success);font-weight:700">✓ 점검 이상 없음 — ' + done.length + '건 청구 가능</span>'
                  : '<span style="color:var(--warning);font-weight:700">⚠ ' + issues + '건 확인 필요 (상병코드/진료비 누락)</span>') +
              '</div>') +
        '</div>' +
      '</div>';

  } else if(tab==='review') {
    content.innerHTML =
      '<div class="card" style="margin-top:12px">' +
        '<div class="card-header"><div class="card-title">🔍 심사 현황</div></div>' +
        '<div style="text-align:center;padding:24px;color:var(--text-muted)">' +
          'EDI 전송 후 심평원 심사 결과가 여기에 표시됩니다<br>' +
          '<small>심사 결과는 전송 후 약 10~15일 소요됩니다</small>' +
        '</div>' +
      '</div>';
  }
}

function renderRadiology(el) {
  const pending = DB.radiologyImages.filter(i => i.status !== '판독완료');
  const done = DB.radiologyImages.filter(i => i.status === '판독완료');
  el.innerHTML = `
  <div class="section-title">🩻 영상의학과 — 워크리스트 (Worklist)</div>
  <div class="grid-4" style="margin-bottom:16px">
    <div class="stat-card blue"><div class="stat-label">오늘 영상 건수</div><div class="stat-value">${DB.radiologyImages.length}</div><div class="stat-sub">X-Ray ${DB.radiologyImages.filter(i=>i.modality==='X-RAY').length} | CT ${DB.radiologyImages.filter(i=>i.modality==='CT').length} | MRI ${DB.radiologyImages.filter(i=>i.modality==='MRI').length}</div></div>
    <div class="stat-card red"><div class="stat-label">판독 대기</div><div class="stat-value">${pending.length}</div><div class="stat-sub">긴급 ${pending.filter(i=>i.urgent).length}건</div></div>
    <div class="stat-card green"><div class="stat-label">판독 완료</div><div class="stat-value">${done.length}</div></div>
    <div class="stat-card orange"><div class="stat-label">업로드 대기</div><div class="stat-value">1</div><div class="stat-sub">PACS 연동 중</div></div>
  </div>

  <!-- 상단 필터 -->
  <div class="card" style="margin-bottom:16px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <select class="form-control" style="width:auto" onchange="filterRadiology(this.value,'modality')">
        <option value="">전체 촬영종류</option><option>X-RAY</option><option>CT</option><option>MRI</option><option>초음파</option>
      </select>
      <select class="form-control" style="width:auto" onchange="filterRadiology(this.value,'dept')">
        <option value="">전체 의뢰과</option><option value="ortho1">정형외과1</option><option value="ortho2">정형외과2</option><option value="neuro">신경외과</option><option value="internal">내과</option>
      </select>
      <select class="form-control" style="width:auto">
        <option>전체 상태</option><option>판독대기</option><option>판독완료</option><option>긴급</option>
      </select>
      <input class="form-control" placeholder="환자명 / 등록번호 검색" style="flex:1;max-width:240px">
      <button class="btn btn-primary" onclick="openUploadModal()">📤 영상 업로드 (PACS)</button>
      <button class="btn btn-outline">📊 통계 출력</button>
    </div>
  </div>

  <!-- 워크리스트 테이블 -->
  <div class="card" style="margin-bottom:16px">
    <div class="card-header"><div class="card-title">📋 오늘 판독 목록</div></div>
    <div class="tbl-wrap">
      <table class="radiology-worklist">
        <thead><tr>
          <th>우선순위</th><th>영상번호</th><th>환자명</th><th>등록번호</th>
          <th>촬영종류</th><th>촬영부위</th><th>촬영방향</th>
          <th>의뢰과</th><th>의뢰의</th><th>촬영일시</th>
          <th>판독상태</th><th>판독의</th><th>관리</th>
        </tr></thead>
        <tbody>
          ${DB.radiologyImages.map(img => `
          <tr class="${img.urgent ? 'urgent-row' : ''}" id="wl-row-${img.id}">
            <td style="text-align:center">
              ${img.urgent ? '<span class="wl-urgent-dot"></span><strong style="color:var(--danger);font-size:11px">긴급</strong>' : '<span style="color:var(--text-muted);font-size:11px">일반</span>'}
            </td>
            <td style="font-family:var(--mono);font-size:11px;color:var(--primary)">${img.id}</td>
            <td><strong>${img.ptName}</strong></td>
            <td style="font-family:var(--mono);font-size:11px">${img.ptId}</td>
            <td><span class="modality-badge modality-${img.modality.toLowerCase().replace('-','')}">${img.modality}</span></td>
            <td style="font-weight:600">${img.body}</td>
            <td style="font-size:11px;color:var(--text-muted)">${img.view}</td>
            <td style="font-size:11px">${{ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과'}[img.dept]||img.dept}</td>
            <td style="font-size:11px">${img.requestDr}</td>
            <td style="font-family:var(--mono);font-size:11px">${img.date}</td>
            <td>
              <span class="img-status-badge ${img.status==='판독완료'?'img-status-done':img.urgent?'img-status-urgent':'img-status-wait'}">
                ${img.status==='판독완료'?'✓ '+img.status:img.urgent?'🔴 긴급대기':'⏳ '+img.status}
              </span>
            </td>
            <td style="font-size:11px">${img.status==='판독완료'?'영상의학 판독의':'-'}</td>
            <td>
              <div class="btn-group">
                <button class="btn btn-sm btn-primary" onclick="openDicomViewer('${img.id}')">🩻 영상 보기</button>
                ${img.status==='판독완료'?'<button class="btn btn-sm btn-ghost" onclick="openRadReportModal(\''+img.id+'\')">📄 판독문</button>':'<button class="btn btn-sm btn-warning" onclick="openDicomViewer(\''+img.id+'\')">판독 시작</button>'}
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <!-- 환자별 영상 이력 -->
  <div class="card">
    <div class="card-header"><div class="card-title">📁 환자별 영상 조회</div></div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <input class="form-control" placeholder="환자명 또는 등록번호" style="max-width:240px" id="radiology-pt-search">
      <button class="btn btn-outline" onclick="searchRadiologyByPt()">검색</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px" id="radiology-pt-result">
      ${DB.radiologyImages.map(img => `
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;cursor:pointer;transition:box-shadow 0.15s" onclick="openDicomViewer('${img.id}')" onmouseover="this.style.boxShadow='var(--shadow-md)'" onmouseout="this.style.boxShadow='none'">
        <div style="background:#111827;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;position:relative">
          ${generateDicomThumbnailSVG(img)}
          <div style="position:absolute;top:6px;left:6px">
            <span class="modality-badge modality-${img.modality.toLowerCase().replace('-','')}">${img.modality}</span>
          </div>
          ${img.urgent ? '<div style="position:absolute;top:6px;right:6px;background:#e53935;color:#fff;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;animation:pulse 1s infinite">STAT</div>' : ''}
        </div>
        <div style="padding:8px 10px">
          <div style="font-weight:700;font-size:12px">${img.ptName}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${img.body} · ${img.view}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
            <span style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">${img.date}</span>
            <span class="img-status-badge ${img.status==='판독완료'?'img-status-done':'img-status-wait'}" style="font-size:9px;padding:1px 6px">${img.status}</span>
          </div>
        </div>
      </div>`).join('')}
    </div>
  </div>`;
}

function generateDicomThumbnailSVG(img) {
  const colors = { 'X-RAY': '#ddd', 'CT': '#b0c4de', 'MRI': '#90ee90', 'US': '#87ceeb' };
  const c = colors[img.modality] || '#ccc';
  // Draw body-part silhouette as SVG
  const svgs = {
    'L-SPINE': `<svg width="80" height="90" viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg">
      <rect x="32" y="5" width="16" height="80" rx="4" fill="none" stroke="${c}" stroke-width="2" opacity="0.8"/>
      ${[15,27,39,51,63].map(y=>`<rect x="20" y="${y}" width="40" height="9" rx="3" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.6"/>`).join('')}
      <ellipse cx="40" cy="88" rx="18" ry="6" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.5"/>
    </svg>`,
    'C-SPINE': `<svg width="80" height="90" viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg">
      <rect x="33" y="5" width="14" height="75" rx="3" fill="none" stroke="${c}" stroke-width="2" opacity="0.8"/>
      ${[8,18,28,38,48,58,68].map(y=>`<rect x="22" y="${y}" width="36" height="7" rx="2" fill="none" stroke="${c}" stroke-width="1.2" opacity="0.6"/>`).join('')}
    </svg>`,
    'HEAD': `<svg width="80" height="90" viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="40" cy="40" rx="32" ry="38" fill="none" stroke="${c}" stroke-width="2" opacity="0.8"/>
      <ellipse cx="40" cy="40" rx="22" ry="28" fill="none" stroke="${c}" stroke-width="1" opacity="0.4"/>
      <line x1="8" y1="40" x2="72" y2="40" stroke="${c}" stroke-width="0.8" opacity="0.3"/>
      <line x1="40" y1="2" x2="40" y2="78" stroke="${c}" stroke-width="0.8" opacity="0.3"/>
    </svg>`,
    'SHOULDER': `<svg width="80" height="90" viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 20 Q10 30 12 50 Q14 65 25 70 Q35 75 40 72" fill="none" stroke="${c}" stroke-width="2" opacity="0.8"/>
      <circle cx="42" cy="42" r="20" fill="none" stroke="${c}" stroke-width="2" opacity="0.7"/>
      <path d="M42 22 Q55 25 60 42 Q65 58 55 68" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.6"/>
    </svg>`,
    'KNEE': `<svg width="80" height="90" viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg">
      <rect x="28" y="5" width="24" height="35" rx="4" fill="none" stroke="${c}" stroke-width="2" opacity="0.8"/>
      <rect x="28" y="50" width="24" height="35" rx="4" fill="none" stroke="${c}" stroke-width="2" opacity="0.8"/>
      <ellipse cx="40" cy="45" rx="16" ry="8" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.6"/>
    </svg>`,
  };
  const bodyKey = Object.keys(svgs).find(k => img.body.includes(k)) || 'L-SPINE';
  return `<div style="opacity:0.7">${svgs[bodyKey]}</div>`;
}

// ─── DICOM VIEWER ────────────────────────────────────────
let dicomState = {
  currentImg: null, brightness: 0, contrast: 100,
  zoom: 1, panX: 0, panY: 0, rotation: 0, flipped: false, inverted: false,
  tool: 'pan', isDragging: false, lastX: 0, lastY: 0, slice: 1, sliceMax: 20,
  isPlaying: false
};

function openDicomViewer(imgId) {
  const img = DB.radiologyImages.find(i => i.id === imgId);
  if(!img) return;
  dicomState.currentImg = img;
  dicomState.brightness = 0; dicomState.contrast = 100;
  dicomState.zoom = 1; dicomState.panX = 0; dicomState.panY = 0;
  dicomState.rotation = 0; dicomState.flipped = false; dicomState.inverted = false;
  dicomState.slice = 1;

  // 모달 헤더 채우기
  document.getElementById('dicom-modal-title').textContent = `🩻 ${img.ptName} — ${img.body}`;
  const mEl = document.getElementById('dicom-modal-modality');
  mEl.textContent = img.modality;
  mEl.className = `modality-badge modality-${img.modality.toLowerCase().replace('-','')}`;
  document.getElementById('dicom-modal-body').textContent = img.view;
  document.getElementById('dicom-modal-ptinfo').textContent = `${img.ptId} | 의뢰: ${img.requestDr} | ${img.date}`;

  // 판독 정보 패널
  document.getElementById('dicom-reading-info').innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:#6b7a99">촬영부위</span><span style="color:#e0e0e0;font-weight:600">${img.body}</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:#6b7a99">방향</span><span style="color:#e0e0e0">${img.view}</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:#6b7a99">의뢰과</span><span style="color:#e0e0e0">${{ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과'}[img.dept]||img.dept}</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:#6b7a99">의뢰의</span><span style="color:#e0e0e0">${img.requestDr}</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:#6b7a99">촬영일</span><span style="color:#e0e0e0;font-family:var(--mono)">${img.date}</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:#6b7a99">보험유형</span><span style="color:#e0e0e0">건강보험</span>
    </div>
    <div style="margin-top:4px;padding:6px 8px;background:rgba(26,79,160,0.3);border-radius:4px">
      <span style="color:#90caf9;font-size:10px;font-weight:700">상태: </span>
      <span style="color:${img.status==='판독완료'?'#80e27e':'#ffb74d'};font-size:11px;font-weight:600">${img.status}</span>
    </div>`;

  // 판독 텍스트
  document.getElementById('dicom-findings').value = img.findings || '';
  document.getElementById('dicom-conclusion').value = img.conclusion || '';

  // 이전 영상 목록
  const prior = DB.radiologyImages.filter(i => i.ptId === img.ptId && i.id !== img.id);
  document.getElementById('dicom-prior-studies').innerHTML = prior.length ?
    prior.map(p => `<div style="padding:5px 0;border-bottom:1px solid #1e3a5f;cursor:pointer" onclick="openDicomViewer('${p.id}')">
      <span class="modality-badge modality-${p.modality.toLowerCase()}" style="margin-right:4px">${p.modality}</span>
      <span style="color:#a8bcd8">${p.body}</span>
      <span style="color:#6b7a99;font-size:10px;font-family:var(--mono);float:right">${p.date}</span>
    </div>`).join('') : '<span style="color:#4a5568">이전 영상 없음</span>';

  // 슬라이스 바 표시 여부
  const sliceBar = document.getElementById('dicom-slice-bar');
  if(img.modality === 'CT' || img.modality === 'MRI') {
    sliceBar.style.display = 'flex';
    dicomState.sliceMax = img.modality === 'CT' ? 24 : 18;
    const sl = document.getElementById('slice-slider');
    sl.max = dicomState.sliceMax;
    sl.value = 1;
    document.getElementById('slice-label').textContent = `1 / ${dicomState.sliceMax}`;
  } else {
    sliceBar.style.display = 'none';
  }

  // 썸네일 사이드바
  buildDicomSidebar(img);

  // brightness/contrast 리셋
  document.getElementById('brightness-slider').value = 0;
  document.getElementById('contrast-slider').value = 100;

  openModal('modal-dicom');
  setTimeout(() => drawDicomCanvas(img), 80);
}

function buildDicomSidebar(img) {
  const sidebar = document.getElementById('dicom-sidebar');
  const samePatient = DB.radiologyImages.filter(i => i.ptId === img.ptId);
  sidebar.innerHTML = samePatient.map((si, idx) => `
  <div class="dicom-thumb ${si.id===img.id?'active':''}" onclick="openDicomViewer('${si.id}')" title="${si.body} ${si.date}">
    <div class="dicom-thumb-canvas" style="background:#111;display:flex;align-items:center;justify-content:center">
      <svg width="70" height="70" viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg" style="opacity:0.7">
        ${generateThumbSVGContent(si)}
      </svg>
    </div>
    <div class="dicom-thumb-label">
      <div style="color:${{'X-RAY':'#90caf9','CT':'#c5cae9','MRI':'#a5d6a7'}[si.modality]||'#aaa'};font-weight:700">${si.modality}</div>
      <div>${si.body}</div>
      <div style="font-size:8px;color:#666">${si.date.substr(5)}</div>
    </div>
  </div>`).join('');
}

function generateThumbSVGContent(img) {
  const c = {'X-RAY':'#b0c4de','CT':'#9fa8da','MRI':'#80cbc4'}[img.modality]||'#ccc';
  if(img.body.includes('SPINE') || img.body.includes('SPINE')) {
    return `<rect x="34" y="5" width="12" height="70" rx="3" fill="none" stroke="${c}" stroke-width="2"/>
    ${[10,22,34,46,58,68].map(y=>`<rect x="20" y="${y}" width="40" height="8" rx="2" fill="none" stroke="${c}" stroke-width="1.2" opacity="0.6"/>`).join('')}`;
  } else if(img.body.includes('HEAD')) {
    return `<ellipse cx="40" cy="42" rx="28" ry="34" fill="none" stroke="${c}" stroke-width="2"/>
    <ellipse cx="40" cy="42" rx="18" ry="24" fill="none" stroke="${c}" stroke-width="1" opacity="0.5"/>`;
  } else if(img.body.includes('SHOULDER')) {
    return `<circle cx="42" cy="42" r="18" fill="none" stroke="${c}" stroke-width="2"/>
    <path d="M20 20 Q12 35 14 52 Q16 65 28 70" fill="none" stroke="${c}" stroke-width="2"/>`;
  } else {
    return `<rect x="25" y="10" width="30" height="70" rx="5" fill="none" stroke="${c}" stroke-width="2"/>
    <line x1="25" y1="40" x2="55" y2="40" stroke="${c}" stroke-width="1" opacity="0.6"/>`;
  }
}

function drawDicomCanvas(img) {
  const canvas = document.getElementById('dicom-canvas');
  if(!canvas) return;
  const wrap = document.getElementById('dicom-canvas-wrap');
  const w = wrap.clientWidth - 20;
  const h = wrap.clientHeight - 20;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Clear
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(w/2 + dicomState.panX, h/2 + dicomState.panY);
  ctx.scale(dicomState.zoom * (dicomState.flipped ? -1 : 1), dicomState.zoom);
  ctx.rotate(dicomState.rotation * Math.PI / 180);

  // Draw simulated medical image
  drawSimulatedImage(ctx, img, w, h);

  ctx.restore();

  // Apply brightness/contrast via CSS filter
  const brightness = 1 + dicomState.brightness/100;
  const contrast = dicomState.contrast/100;
  const invert = dicomState.inverted ? 1 : 0;
  canvas.style.filter = `brightness(${brightness}) contrast(${contrast}) invert(${invert})`;

  // Update overlay info
  updateDicomOverlay(img);
}

function drawSimulatedImage(ctx, img, cw, ch) {
  const iw = Math.min(cw * 0.65, 380), ih = Math.min(ch * 0.85, 450);
  const x0 = -iw/2, y0 = -ih/2;

  if(img.modality === 'X-RAY') {
    drawXRay(ctx, img, x0, y0, iw, ih);
  } else if(img.modality === 'CT') {
    drawCT(ctx, img, x0, y0, iw, ih);
  } else if(img.modality === 'MRI') {
    drawMRI(ctx, img, x0, y0, iw, ih);
  }
}

function drawXRay(ctx, img, x0, y0, iw, ih) {
  // Background gradient (film)
  const bg = ctx.createRadialGradient(0, 0, iw*0.1, 0, 0, iw*0.9);
  bg.addColorStop(0, '#1a1a1a');
  bg.addColorStop(1, '#050505');
  ctx.fillStyle = bg;
  ctx.fillRect(x0, y0, iw, ih);

  if(img.body.includes('SPINE')) {
    drawSpineXRay(ctx, x0, y0, iw, ih, img.body.includes('C-'));
  } else if(img.body.includes('HEAD')) {
    drawSkullXRay(ctx, x0, y0, iw, ih);
  } else if(img.body.includes('SHOULDER')) {
    drawShoulderXRay(ctx, x0, y0, iw, ih);
  } else if(img.body.includes('KNEE')) {
    drawKneeXRay(ctx, x0, y0, iw, ih);
  }
}

function drawSpineXRay(ctx, x0, y0, iw, ih, isCervical) {
  const cx = x0 + iw/2, cy = y0 + ih/2;
  const levels = isCervical ? 7 : 5;
  const startY = y0 + ih*0.1, endY = y0 + ih*0.9;
  const step = (endY - startY) / (levels + 1);

  // Vertebral bodies
  for(let i = 0; i < levels; i++) {
    const vy = startY + step * (i + 0.5);
    const vw = iw * (isCervical ? 0.28 : 0.32);
    const vh = step * 0.65;

    // Cortex
    ctx.fillStyle = `rgba(200,200,200,${0.55 + i*0.04})`;
    ctx.beginPath();
    ctx.roundRect(cx - vw/2, vy - vh/2, vw, vh, 3);
    ctx.fill();

    // Cancellous bone texture
    ctx.fillStyle = `rgba(120,120,120,0.4)`;
    ctx.beginPath();
    ctx.roundRect(cx - vw/2 + 3, vy - vh/2 + 3, vw - 6, vh - 6, 2);
    ctx.fill();

    // Endplates
    ctx.fillStyle = 'rgba(240,240,240,0.7)';
    ctx.fillRect(cx - vw/2, vy - vh/2, vw, 2);
    ctx.fillRect(cx - vw/2, vy + vh/2 - 2, vw, 2);

    // Pedicles (AP view)
    ctx.fillStyle = 'rgba(180,180,180,0.5)';
    ctx.beginPath();
    ctx.ellipse(cx - vw/2 - 8, vy, 6, 5, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + vw/2 + 8, vy, 6, 5, 0, 0, Math.PI*2);
    ctx.fill();

    // Disc space (narrowed at L4-5 for pathology)
    if(i < levels-1) {
      const discH = i === levels-2 ? step*0.15 : step*0.25;
      ctx.fillStyle = `rgba(30,30,30,0.8)`;
      ctx.fillRect(cx - vw/2, vy + vh/2, vw, step - vh);
    }
  }

  // Spinous processes
  for(let i = 0; i < levels; i++) {
    const vy = startY + step*(i+0.5);
    ctx.fillStyle = 'rgba(160,160,160,0.5)';
    ctx.beginPath();
    ctx.roundRect(cx - 4, vy - step*0.2, 8, step*0.4, 2);
    ctx.fill();
  }

  // Soft tissue
  const grad = ctx.createLinearGradient(x0, 0, x0+iw, 0);
  grad.addColorStop(0, 'rgba(60,40,30,0.5)');
  grad.addColorStop(0.3, 'rgba(0,0,0,0)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(60,40,30,0.5)');
  ctx.fillStyle = grad;
  ctx.fillRect(x0, y0, iw, ih);
}

function drawSkullXRay(ctx, x0, y0, iw, ih) {
  const cx = x0+iw/2, cy = y0+ih/2;
  ctx.strokeStyle = 'rgba(200,200,200,0.7)'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy, iw*0.42, ih*0.44, 0, 0, Math.PI*2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(160,160,160,0.4)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, iw*0.32, ih*0.34, 0, 0, Math.PI*2);
  ctx.stroke();
  // Sutures
  ctx.strokeStyle = 'rgba(180,180,180,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, cy-ih*0.44); ctx.lineTo(cx, cy-ih*0.1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx-iw*0.3, cy); ctx.lineTo(cx+iw*0.3, cy); ctx.stroke();
  // Orbits
  ctx.strokeStyle = 'rgba(140,140,140,0.6)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(cx-iw*0.13, cy+ih*0.05, iw*0.1, ih*0.07, 0, 0, Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(cx+iw*0.13, cy+ih*0.05, iw*0.1, ih*0.07, 0, 0, Math.PI*2); ctx.stroke();
}

function drawShoulderXRay(ctx, x0, y0, iw, ih) {
  const cx = x0+iw/2, cy = y0+ih/2;
  // Humeral head
  ctx.fillStyle = 'rgba(190,190,190,0.65)';
  ctx.beginPath(); ctx.arc(cx+iw*0.1, cy-ih*0.05, iw*0.18, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = 'rgba(120,120,120,0.4)';
  ctx.beginPath(); ctx.arc(cx+iw*0.1, cy-ih*0.05, iw*0.13, 0, Math.PI*2); ctx.fill();
  // Glenoid
  ctx.strokeStyle = 'rgba(200,200,200,0.7)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(cx-iw*0.06, cy-ih*0.02, iw*0.09, -0.8, 0.8, false); ctx.stroke();
  // Calcification (pathology)
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(cx+iw*0.05, cy-ih*0.2, 6, 0, Math.PI*2); ctx.fill();
  // Clavicle
  ctx.strokeStyle = 'rgba(210,210,210,0.7)'; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(x0+10, cy-ih*0.22); ctx.quadraticCurveTo(cx-iw*0.15, cy-ih*0.28, cx-iw*0.08, cy-ih*0.1); ctx.stroke();
  // Acromion
  ctx.strokeStyle = 'rgba(180,180,180,0.6)'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(cx-iw*0.08, cy-ih*0.1); ctx.lineTo(cx+iw*0.08, cy-ih*0.08); ctx.stroke();
}

function drawKneeXRay(ctx, x0, y0, iw, ih) {
  const cx = x0+iw/2, cy = y0+ih/2;
  // Femur
  ctx.fillStyle = 'rgba(180,180,180,0.65)';
  ctx.beginPath(); ctx.roundRect(cx-iw*0.12, y0+ih*0.05, iw*0.25, ih*0.4, 4); ctx.fill();
  ctx.fillStyle = 'rgba(110,110,110,0.4)';
  ctx.beginPath(); ctx.roundRect(cx-iw*0.08, y0+ih*0.07, iw*0.17, ih*0.36, 3); ctx.fill();
  // Femoral condyles
  ctx.fillStyle = 'rgba(185,185,185,0.7)';
  ctx.beginPath(); ctx.ellipse(cx-iw*0.1, y0+ih*0.46, iw*0.1, ih*0.06, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx+iw*0.1, y0+ih*0.46, iw*0.1, ih*0.06, 0, 0, Math.PI*2); ctx.fill();
  // Tibia - medial joint space narrowing
  const tibiaMedW = iw * 0.13, tibiaLatW = iw * 0.13;
  ctx.fillStyle = 'rgba(175,175,175,0.65)';
  ctx.beginPath(); ctx.roundRect(cx-iw*0.14, y0+ih*0.54, tibiaMedW, ih*0.38, 3); ctx.fill();
  ctx.beginPath(); ctx.roundRect(cx+iw*0.01, y0+ih*0.52, tibiaLatW, ih*0.38, 3); ctx.fill();
  // Medial joint space (narrowed - pathology)
  ctx.fillStyle = '#000';
  ctx.fillRect(cx-iw*0.14, y0+ih*0.495, tibiaMedW, ih*0.042);
  // Lateral joint space (normal)
  ctx.fillRect(cx+iw*0.01, y0+ih*0.495, tibiaLatW, ih*0.022);
  // Osteophyte
  ctx.fillStyle = 'rgba(230,230,230,0.85)';
  ctx.beginPath(); ctx.arc(cx-iw*0.15, y0+ih*0.52, 5, 0, Math.PI*2); ctx.fill();
  // Patella
  ctx.fillStyle = 'rgba(160,160,160,0.6)';
  ctx.beginPath(); ctx.ellipse(cx, y0+ih*0.38, iw*0.08, ih*0.07, 0, 0, Math.PI*2); ctx.fill();
}

function drawCT(ctx, img, x0, y0, iw, ih) {
  const cx = x0+iw/2, cy = y0+ih/2;
  const r = Math.min(iw,ih)*0.46;

  // Circular CT FOV
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.clip();

  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  bg.addColorStop(0, '#2a2a2a'); bg.addColorStop(0.7, '#1a1a1a'); bg.addColorStop(1, '#080808');
  ctx.fillStyle = bg; ctx.fillRect(x0, y0, iw, ih);

  if(img.body.includes('HEAD')) {
    drawCTHead(ctx, cx, cy, r);
  } else if(img.body.includes('SPINE')) {
    drawCTSpine(ctx, cx, cy, r);
  }
  ctx.restore();

  // CT scale bar
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(x0+iw-40, y0+ih-12, 36, 8);
}

function drawCTHead(ctx, cx, cy, r) {
  // Skull
  ctx.strokeStyle = 'rgba(230,230,200,0.85)'; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(cx, cy, r*0.9, 0, Math.PI*2); ctx.stroke();
  // Brain parenchyma
  const brain = ctx.createRadialGradient(cx, cy, 0, cx, cy, r*0.78);
  brain.addColorStop(0, 'rgba(100,80,60,0.7)'); brain.addColorStop(0.6, 'rgba(80,65,50,0.65)'); brain.addColorStop(1, 'rgba(50,40,30,0.6)');
  ctx.fillStyle = brain;
  ctx.beginPath(); ctx.arc(cx, cy, r*0.78, 0, Math.PI*2); ctx.fill();
  // Gyri/sulci
  for(let a=0;a<12;a++) {
    const ang = (a/12)*Math.PI*2;
    ctx.strokeStyle = 'rgba(30,25,20,0.4)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang)*r*0.35, cy + Math.sin(ang)*r*0.35, r*0.2, ang-0.8, ang+0.8);
    ctx.stroke();
  }
  // Falx cerebri
  ctx.strokeStyle = 'rgba(200,180,150,0.5)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, cy-r*0.75); ctx.lineTo(cx, cy+r*0.75); ctx.stroke();
  // Ventricles
  ctx.fillStyle = 'rgba(20,30,60,0.8)';
  ctx.beginPath(); ctx.ellipse(cx-r*0.12, cy, r*0.08, r*0.22, -0.3, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx+r*0.12, cy, r*0.08, r*0.22, 0.3, 0, Math.PI*2); ctx.fill();
  // Orbits
  ctx.strokeStyle = 'rgba(40,40,30,0.9)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(cx-r*0.22, cy+r*0.15, r*0.12, r*0.1, 0, 0, Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(cx+r*0.22, cy+r*0.15, r*0.12, r*0.1, 0, 0, Math.PI*2); ctx.stroke();
}

function drawCTSpine(ctx, cx, cy, r) {
  const bg2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  bg2.addColorStop(0, '#2a2018'); bg2.addColorStop(1, '#0f0d0a');
  ctx.fillStyle = bg2; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
  // Vertebral body
  ctx.fillStyle = 'rgba(190,190,160,0.75)';
  ctx.beginPath(); ctx.roundRect(cx-r*0.35, cy-r*0.3, r*0.7, r*0.6, 8); ctx.fill();
  ctx.fillStyle = 'rgba(100,90,70,0.5)';
  ctx.beginPath(); ctx.roundRect(cx-r*0.28, cy-r*0.23, r*0.56, r*0.46, 5); ctx.fill();
  // Spinal canal
  ctx.fillStyle = 'rgba(15,15,20,0.9)';
  ctx.beginPath(); ctx.arc(cx, cy, r*0.12, 0, Math.PI*2); ctx.fill();
  // Neural foramina
  ctx.fillStyle = 'rgba(20,20,30,0.8)';
  ctx.beginPath(); ctx.ellipse(cx-r*0.52, cy, r*0.08, r*0.1, 0.3, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx+r*0.52, cy, r*0.08, r*0.1, -0.3, 0, Math.PI*2); ctx.fill();
  // Posterior elements
  ctx.strokeStyle = 'rgba(160,160,130,0.6)'; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(cx-r*0.38, cy); ctx.lineTo(cx-r*0.55, cy-r*0.3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx+r*0.38, cy); ctx.lineTo(cx+r*0.55, cy-r*0.3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy-r*0.12); ctx.lineTo(cx, cy-r*0.5); ctx.stroke();
  // Disc herniation (pathology)
  ctx.fillStyle = 'rgba(180,140,100,0.6)';
  ctx.beginPath(); ctx.arc(cx, cy+r*0.32, r*0.1, 0, Math.PI*2); ctx.fill();
  // Soft tissue
  const st = ctx.createRadialGradient(cx, cy, r*0.55, cx, cy, r);
  st.addColorStop(0,'rgba(60,45,35,0.3)'); st.addColorStop(1,'rgba(30,22,15,0.6)');
  ctx.fillStyle = st; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
}

function drawMRI(ctx, img, x0, y0, iw, ih) {
  const cx = x0+iw/2, cy = y0+ih/2;
  const r = Math.min(iw,ih)*0.44;
  ctx.save();
  ctx.beginPath(); ctx.ellipse(cx, cy, iw*0.44, ih*0.46, 0, 0, Math.PI*2); ctx.clip();

  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r*1.2);
  bg.addColorStop(0, '#1a1208'); bg.addColorStop(1, '#0a0806');
  ctx.fillStyle = bg; ctx.fillRect(x0, y0, iw, ih);

  if(img.body.includes('SPINE') || img.body.includes('C-')) {
    drawMRISpine(ctx, cx, cy, r, img.body.includes('C-'));
  } else {
    drawMRISpine(ctx, cx, cy, r, false);
  }
  ctx.restore();
}

function drawMRISpine(ctx, cx, cy, r, isCervical) {
  const levels = isCervical ? 7 : 5;
  const startY = cy - r*0.8, endY = cy + r*0.8;
  const step = (endY - startY) / (levels + 1);
  const vw = r * (isCervical ? 0.5 : 0.55);

  for(let i=0; i<levels; i++) {
    const vy = startY + step*(i+0.5);
    const vh = step * 0.62;
    // T2 vertebral body (bright)
    const vGrad = ctx.createLinearGradient(cx-vw/2, vy, cx+vw/2, vy);
    vGrad.addColorStop(0, 'rgba(180,150,100,0.7)');
    vGrad.addColorStop(0.5, 'rgba(200,170,120,0.8)');
    vGrad.addColorStop(1, 'rgba(180,150,100,0.7)');
    ctx.fillStyle = vGrad;
    ctx.beginPath(); ctx.roundRect(cx-vw/2, vy-vh/2, vw, vh, 4); ctx.fill();
    // Cortical endplates
    ctx.fillStyle = 'rgba(30,30,20,0.85)';
    ctx.fillRect(cx-vw/2, vy-vh/2, vw, 2);
    ctx.fillRect(cx-vw/2, vy+vh/2-2, vw, 2);
    // Posterior arch / spinous
    ctx.fillStyle = 'rgba(160,130,90,0.55)';
    ctx.beginPath(); ctx.roundRect(cx+vw/2-2, vy-vh*0.3, vw*0.5, vh*0.6, 3); ctx.fill();
    ctx.beginPath(); ctx.arc(cx+vw/2+vw*0.4, vy, 6, 0, Math.PI*2); ctx.fill();

    // Disc
    if(i < levels-1) {
      const discH = (i===levels-2) ? step*0.14 : step*0.26;
      const discY = vy + vh/2;
      // Nucleus (bright on T2)
      const nucGrad = ctx.createRadialGradient(cx, discY+discH/2, 0, cx, discY+discH/2, vw*0.3);
      const isHerniated = i === levels-2;
      nucGrad.addColorStop(0, isHerniated ? 'rgba(60,80,120,0.6)' : 'rgba(80,120,180,0.8)');
      nucGrad.addColorStop(1, isHerniated ? 'rgba(30,40,60,0.5)' : 'rgba(40,70,120,0.5)');
      ctx.fillStyle = nucGrad;
      ctx.beginPath(); ctx.roundRect(cx-vw*0.35, discY, vw*0.7, discH, 3); ctx.fill();
      // Annulus
      ctx.strokeStyle = 'rgba(50,50,40,0.5)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(cx-vw/2, discY, vw, discH);
      // Herniation bulge
      if(isHerniated) {
        ctx.fillStyle = 'rgba(80,100,160,0.5)';
        ctx.beginPath(); ctx.ellipse(cx+vw/2+8, discY+discH/2, 10, 6, 0, 0, Math.PI*2); ctx.fill();
      }
    }
  }
  // Spinal cord / CSF
  ctx.fillStyle = 'rgba(120,160,220,0.35)';
  ctx.beginPath(); ctx.roundRect(cx-vw*0.08, startY-5, vw*0.16, endY-startY+10, 4); ctx.fill();
}

function updateDicomOverlay(img) {
  const ptId = img ? img.ptId : ''; 
  const pt = DB.patients.find(p => p.id === ptId);
  const ptName = img ? img.ptName : '';
  document.getElementById('dicom-info-top-left').innerHTML = img ? 
    `${ptName}<br>${pt ? calcAge(pt.dob)+'세 '+pt.gender : ''}<br>${ptId}<br>${img.modality} | ${img.body}` : '';
  document.getElementById('dicom-info-top-right').innerHTML = img ? 
    `${img.date}<br>JUNGDONG EMR<br>W:400 L:40<br>${img.view}` : '';
}

// ─── DICOM TOOLS ────────────────────────────────────────
function setTool(tool) {
  dicomState.tool = tool;
  document.querySelectorAll('.dicom-btn[id^=tool-]').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('tool-'+tool);
  if(el) el.classList.add('active');
}

function adjustBrightness(v) {
  dicomState.brightness = parseInt(v);
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function adjustContrast(v) {
  dicomState.contrast = parseInt(v);
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function resetView() {
  dicomState.brightness=0; dicomState.contrast=100; dicomState.zoom=1;
  dicomState.panX=0; dicomState.panY=0; dicomState.rotation=0;
  dicomState.flipped=false; dicomState.inverted=false;
  document.getElementById('brightness-slider').value=0;
  document.getElementById('contrast-slider').value=100;
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function invertImage() {
  dicomState.inverted = !dicomState.inverted;
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function rotateImage() {
  dicomState.rotation = (dicomState.rotation + 90) % 360;
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function flipHorizontal() {
  dicomState.flipped = !dicomState.flipped;
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function zoomIn() {
  dicomState.zoom = Math.min(dicomState.zoom + 0.25, 5);
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function zoomOut() {
  dicomState.zoom = Math.max(dicomState.zoom - 0.25, 0.25);
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function changeSlice(v) {
  dicomState.slice = parseInt(v);
  document.getElementById('slice-label').textContent = `${v} / ${dicomState.sliceMax}`;
  if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
}
function playSlices() {
  if(dicomState.isPlaying) return;
  dicomState.isPlaying = true;
  let s = 1;
  const sl = document.getElementById('slice-slider');
  const timer = setInterval(() => {
    s = (s % dicomState.sliceMax) + 1;
    sl.value = s;
    document.getElementById('slice-label').textContent = `${s} / ${dicomState.sliceMax}`;
    if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
    if(s >= dicomState.sliceMax) { clearInterval(timer); dicomState.isPlaying = false; }
  }, 200);
}
function fullscreen() {
  const wrap = document.getElementById('dicom-canvas-wrap');
  if(wrap.requestFullscreen) wrap.requestFullscreen();
}

// Canvas mouse events
document.addEventListener('DOMContentLoaded', () => {
  applyLogoUrl();
  const canvas = document.getElementById('dicom-canvas');
  if(!canvas) return;
  canvas.addEventListener('mousedown', (e) => {
    dicomState.isDragging = true;
    dicomState.lastX = e.clientX; dicomState.lastY = e.clientY;
  });
  canvas.addEventListener('mousemove', (e) => {
    if(!dicomState.isDragging) return;
    const dx = e.clientX - dicomState.lastX, dy = e.clientY - dicomState.lastY;
    if(dicomState.tool === 'pan') {
      dicomState.panX += dx; dicomState.panY += dy;
    } else if(dicomState.tool === 'zoom') {
      dicomState.zoom = Math.max(0.25, Math.min(5, dicomState.zoom + dy * -0.01));
    } else if(dicomState.tool === 'wl') {
      dicomState.brightness = Math.max(-100, Math.min(100, dicomState.brightness - dy * 0.5));
      dicomState.contrast = Math.max(50, Math.min(250, dicomState.contrast + dx * 0.5));
      document.getElementById('brightness-slider').value = Math.round(dicomState.brightness);
      document.getElementById('contrast-slider').value = Math.round(dicomState.contrast);
    }
    dicomState.lastX = e.clientX; dicomState.lastY = e.clientY;
    if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
  });
  canvas.addEventListener('mouseup', () => dicomState.isDragging = false);
  canvas.addEventListener('mouseleave', () => dicomState.isDragging = false);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if(e.ctrlKey) {
      dicomState.zoom = Math.max(0.25, Math.min(5, dicomState.zoom - e.deltaY * 0.001));
    } else {
      const sl = document.getElementById('slice-slider');
      if(sl && sl.style.display !== 'none') {
        const newVal = Math.max(1, Math.min(dicomState.sliceMax, dicomState.slice + (e.deltaY > 0 ? 1 : -1)));
        dicomState.slice = newVal; sl.value = newVal;
        document.getElementById('slice-label').textContent = `${newVal} / ${dicomState.sliceMax}`;
      }
    }
    if(dicomState.currentImg) drawDicomCanvas(dicomState.currentImg);
  }, {passive: false});
});

// ─── RADIOLOGY HELPERS ──────────────────────────────────
function filterRadiology(val, key) {}
function searchRadiologyByPt() {
  const q = document.getElementById('radiology-pt-search').value.toLowerCase();
  notify('검색', `"${q}" 환자 영상을 검색합니다.`, 'info');
}
function openUploadModal() {
  openDynamicModal('modal-rad-upload',
    '<div class="modal-title">🩻 영상 등록</div>',
    '<div class="grid-2">' +
      '<div class="form-group"><label>* 환자명/등록번호</label>' +
        '<div style="display:flex;gap:6px">' +
          '<input class="form-control" id="rad-pt-search" placeholder="환자명 또는 등록번호">' +
          '<button class="btn btn-outline" onclick="searchRadPt()">검색</button>' +
        '</div>' +
        '<div id="rad-pt-result" style="margin-top:4px"></div>' +
      '</div>' +
      '<div class="form-group"><label>* 촬영 종류</label>' +
        '<select class="form-control" id="rad-modality">' +
          '<option value="X-RAY">X-RAY</option><option value="CT">CT</option>' +
          '<option value="MRI">MRI</option><option value="초음파">초음파</option>' +
          '<option value="골밀도">골밀도(DEXA)</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>* 촬영 부위</label>' +
        '<select class="form-control" id="rad-body-part">' +
          '<option>경추</option><option>흉추</option><option>요추</option><option>골반</option>' +
          '<option>우측 어깨</option><option>좌측 어깨</option>' +
          '<option>우측 슬관절</option><option>좌측 슬관절</option>' +
          '<option>우측 고관절</option><option>좌측 고관절</option>' +
          '<option>흉부(PA)</option><option>복부</option><option>두부(Brain)</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>의뢰과</label>' +
        '<select class="form-control" id="rad-dept">' +
          '<option value="ortho1">정형외과1</option><option value="ortho2">정형외과2</option>' +
          '<option value="neuro">신경외과</option><option value="internal">내과</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>임상 소견</label>' +
        '<input class="form-control" id="rad-clinical" placeholder="임상 소견 또는 검사 이유"></div>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:10px">' +
        '<label style="white-space:nowrap">긴급 판독</label>' +
        '<input type="checkbox" id="rad-urgent" style="width:16px;height:16px">' +
      '</div>' +
    '</div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-rad-upload\').classList.remove(\'open\')">취소</button>' +
    '<button class="btn btn-primary" onclick="saveRadiologyRecord()">✓ 영상 등록</button>'
  );
}

function searchRadPt() {
  var q = (document.getElementById('rad-pt-search')||{}).value||'';
  var res = document.getElementById('rad-pt-result');
  if(!res||!q) return;
  var found = DB.patientMaster.filter(function(p){return p.name.includes(q)||p.pid.includes(q);}).slice(0,3);
  if(found.length===0){res.innerHTML='<div style="font-size:11px;color:var(--text-muted)">검색 결과 없음</div>';return;}
  res.innerHTML = found.map(function(p){
    return '<div onclick="document.getElementById(\'rad-pt-search\').value=\''+p.name+' ('+p.pid+')\';document.getElementById(\'rad-pt-result\').innerHTML=\'\';" style="padding:5px 8px;background:#f0f7ff;border-radius:4px;cursor:pointer;font-size:11px;margin-top:2px">' +
      '<strong>'+p.name+'</strong> <span style="color:var(--text-muted)">'+p.gender+'·'+calcAge(p.dob)+'세 '+p.pid+'</span></div>';
  }).join('');
}

function openRadReportModal(imgId) {
  var img = DB.radiologyImages.find(function(i){return i.id===imgId;});
  if(!img){notify('오류','영상 정보를 찾을 수 없습니다.','error');return;}
  var deptLabel={ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과'};
  openDynamicModal('modal-rad-report',
    '<div class="modal-title">📋 판독 소견 작성 — '+img.ptName+'</div>',
    '<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">'+
      img.modality+' / '+img.bodyPart+' / 의뢰: '+(deptLabel[img.dept]||img.dept)+
      (img.clinical?' / 임상소견: '+img.clinical:'')+'</div>'+
    (img.report?'<div style="background:#f0f7ff;border-radius:6px;padding:10px;margin-bottom:10px;font-size:11px"><strong>기존 판독:</strong> '+img.report+'</div>':'')+
    '<div class="form-group"><label>판독 소견</label>'+
      '<textarea class="form-control" id="rad-report-text" style="min-height:120px;font-family:var(--font)" placeholder="판독 소견을 입력하세요...">'+
        (img.report||'')+'</textarea></div>'+
    '<div class="form-group"><label>결론</label>'+
      '<select class="form-control" id="rad-conclusion">'+
        '<option value="정상">정상 (Normal)</option>'+
        '<option value="이상소견">이상 소견 (Abnormal)</option>'+
        '<option value="추적관찰필요">추적 관찰 필요</option>'+
        '<option value="추가검사필요">추가 검사 필요</option>'+
      '</select></div>',
    '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-rad-report\').classList.remove(\'open\')">취소</button>'+
    '<button class="btn btn-primary" onclick="saveRadReportFromModal(\''+imgId+'\')">✓ 판독 저장</button>'
  );
  if(img.status==='판독완료') {
    setTimeout(function(){
      var sel = document.getElementById('rad-conclusion');
      if(sel) sel.value = img.conclusion||'정상';
    },50);
  }
}

function saveRadReportFromModal(imgId) {
  var img = DB.radiologyImages.find(function(i){return i.id===imgId;});
  if(!img) return;
  var report = (document.getElementById('rad-report-text')||{}).value||'';
  var conclusion = (document.getElementById('rad-conclusion')||{}).value||'정상';
  if(!report.trim()){notify('오류','판독 소견을 입력하세요.','error');return;}
  img.report = report;
  img.conclusion = conclusion;
  img.status = '판독완료';
  img.reportedAt = new Date().toISOString();
  img.reportedBy = SESSION.user?SESSION.user.name:'-';
  DB.auditLog.push({time:new Date().toISOString(),action:'RADIOLOGY_REPORTED',
    user:SESSION.user?SESSION.user.username:'-',imgId,pt:img.ptName,conclusion});
  document.getElementById('modal-rad-report').classList.remove('open');
  notify('판독 완료',img.ptName+' '+img.modality+' 판독 보고서 저장 완료.','success');
  renderScreen('radiology');
}


function saveRadiologyRecord() {
  var ptVal    = (document.getElementById('rad-pt-search')||{}).value||'';
  var modality = (document.getElementById('rad-modality')||{}).value||'X-RAY';
  var bodyPart = (document.getElementById('rad-body-part')||{}).value||'';
  var dept     = (document.getElementById('rad-dept')||{}).value||'ortho1';
  var clinical = (document.getElementById('rad-clinical')||{}).value||'';
  var urgent   = (document.getElementById('rad-urgent')||{}).checked||false;
  var ptName   = ptVal.split('(')[0].trim();
  if(!ptName){notify('오류','환자를 검색하여 선택해주세요.','error');return;}

  var img = {
    id: 'IMG-'+Date.now(),
    ptName: ptName,
    ptId: ptVal.match(/\(([^)]+)\)/)?.[1]||'',
    modality: modality,
    bodyPart: bodyPart,
    dept: dept,
    clinical: clinical,
    urgent: urgent,
    status: '판독대기',
    takenAt: new Date().toISOString(),
    takenBy: SESSION.user?SESSION.user.name:'-',
    report: '',
    reportedAt: null,
    reportedBy: null,
  };
  DB.radiologyImages.push(img);
  DB.auditLog.push({time:new Date().toISOString(),action:'RADIOLOGY_REGISTERED',
    user:SESSION.user?SESSION.user.username:'-',imgId:img.id,pt:ptName,modality});
  if(urgent) {
    DB.notifications.push({id:'NTF-'+Date.now(),type:'lab_critical',level:'warning',
      message:'긴급 판독 요청: '+ptName+' '+modality+' ('+bodyPart+')',
      time:new Date().toISOString(),read:false});
    updateNotifBadge();
  }
  document.getElementById('modal-rad-upload').classList.remove('open');
  notify('등록 완료',modality+' '+bodyPart+' 영상이 등록되었습니다. 판독 대기.','success');
  renderScreen('radiology');
}

function saveDicomReport(imgId) {
  var img = DB.radiologyImages.find(function(i){return i.id===imgId;});
  if(!img){notify('오류','영상을 찾을 수 없습니다.','error');return;}
  var report = (document.getElementById('rad-report-text-'+imgId)||
                document.getElementById('rad-report-text')||{}).value||'';
  if(!report.trim()){notify('오류','판독 소견을 입력하세요.','error');return;}
  img.report = report;
  img.status = '판독완료';
  img.reportedAt = new Date().toISOString();
  img.reportedBy = SESSION.user?SESSION.user.name:'-';
  DB.auditLog.push({time:new Date().toISOString(),action:'RADIOLOGY_REPORTED',
    user:SESSION.user?SESSION.user.username:'-',imgId,pt:img.ptName});
  document.getElementById('modal-dicom')&&document.getElementById('modal-dicom').classList.remove('open');
  notify('판독 완료',img.ptName+' '+img.modality+' 판독 보고서가 저장되었습니다.','success');
  renderScreen('radiology');
}
function saveReading() {
  const img = dicomState.currentImg;
  if(!img) return;
  img.findings = document.getElementById('dicom-findings').value;
  img.conclusion = document.getElementById('dicom-conclusion').value;
  img.status = '판독완료';
  closeModal('modal-dicom');
  notify('판독 완료', `${img.ptName} 환자 ${img.body} ${img.modality} 판독이 저장되었습니다.`, 'success');
  renderScreen('radiology');
}
function requestConsult() { notify('협진 요청', '협진 요청을 전송합니다.', 'info'); }
function printReport() { notify('출력', '판독문을 출력합니다.', 'info'); }
function printRadReport(id) {
  const img = DB.radiologyImages.find(i => i.id === id);
  if(!img) return;
  notify('판독문 출력', `${img.ptName} ${img.modality} 판독문을 출력합니다.`, 'info');
}
function calcAge(dob) {
  if(!dob) return '?';
  const d = String(dob).replace(/-/g,'');
  const y = parseInt(d.substring(0,4));
  return new Date().getFullYear() - y;
}
function formatDOB(dob) {
  const d = String(dob).replace(/-/g,'');
  return d.length >= 8 ? d.substr(0,4)+'-'+d.substr(4,2)+'-'+d.substr(6,2) : dob;
}

function updateDoctorList(dept) {
  var deptLabel = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과·건강검진',anesthesia:'마취통증의학과',radiology:'영상의학과',health:'건강검진'};
  var doctors = DB.users.filter(function(u){
    return u.status==='active' && (u.role==='hospital_director'||u.role.startsWith('doctor_')) && (!dept||u.dept===dept);
  });
  var makeOpts = function(selId) {
    var sel = document.getElementById(selId);
    if(!sel) return;
    sel.innerHTML = '<option value="">-- 선택 --</option>';
    doctors.forEach(function(u){
      var opt = document.createElement('option');
      opt.value = u.name;
      opt.textContent = u.name + ' (' + (deptLabel[u.dept]||u.dept) + ')';
      sel.appendChild(opt);
    });
    if(doctors.length===0) sel.innerHTML = '<option>담당의 없음 — 계정 관리에서 등록</option>';
  };
  makeOpts('pt-doctor');
  makeOpts('resv-doctor');
}

function setReceptionType(type, el) {
  document.querySelectorAll('#reception-type-tabs .tab').forEach(t => t.classList.remove('active'));
  if(el) el.classList.add('active');
  document.getElementById('reception-new-search').style.display = type === 'first' ? 'block' : 'none';
}

function searchExistingPatient(name) {
  const container = document.getElementById('existing-pt-results');
  if(!container) return;
  const q = name.trim();
  if(!q && arguments.length > 0) { container.innerHTML = ''; return; }
  const results = DB.patientMaster.filter(p =>
    p.name.includes(q) || p.pid.includes(q) || p.dob.includes(q)
  ).slice(0, 5);
  if(results.length === 0) {
    container.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-muted)">검색 결과 없음</div>';
    return;
  }
  container.innerHTML = results.map(p => {
    const vt = VisitTypeEngine.determineType(p.pid, null, null);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-top:6px;cursor:pointer;background:#f8fafd"
      onclick="fillPatientFromMaster('${p.pid}')">
      <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700">${p.name[0]}</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:12px">${p.name} <span style="color:var(--text-muted);font-weight:400">${p.gender} · ${calcAge(p.dob)}세</span></div>
        <div style="font-size:10px;color:var(--text-muted);font-family:var(--mono)">${p.pid} | ${p.insurance} | ${p.phone}</div>
        <div style="font-size:10px;color:var(--text-muted)">방문이력: ${p.visitHistory.length}회 | 마지막: ${p.visitHistory.length>0?p.visitHistory[p.visitHistory.length-1].date:'없음'}</div>
      </div>
      <span class="badge ${vt.badge||'badge-new'}">${vt.type}</span>
      <button class="btn btn-sm btn-primary">선택</button>
    </div>`;
  }).join('');
}

function fillPatientFromMaster(pid) {
  const p = DB.patientMaster.find(x => x.pid === pid);
  if(!p) return;
  // 보험 유형 자동 세팅 (심평원 자격조회 연동 전까지 DB 저장값 사용)
  const insMap = {건강보험:'건강보험', 의료급여1종:'의료급여 1종', 의료급여2종:'의료급여 2종', 자동차보험:'자동차보험', 산재:'산재보험', 비급여:'비급여'};
  const insEl = document.getElementById('reception-insurance') || document.getElementById('admit-insurance');
  if(insEl && p.insuranceType) {
    Array.from(insEl.options).forEach(o => { if(o.value===p.insuranceType||o.text===p.insuranceType) o.selected=true; });
  }
  document.getElementById('pt-name').value = p.name;
  document.getElementById('pt-gender').value = p.gender;
  document.getElementById('pt-dob').value = p.dob;
  document.getElementById('pt-phone').value = p.phone;
  document.getElementById('pt-insurance').value = p.insurance;
  if(p.rrn) document.getElementById('pt-rrn').value = p.rrn.replace(/\*/g,'0');
  checkVisitType();
  notify('환자 불러오기', `${p.name} 환자 정보를 불러왔습니다. 진료과를 선택하세요.`, 'info');
}

function checkUsernameAvail(val) {
  const msg = document.getElementById('cu-username-msg');
  if(!msg) return;
  if(val.length < 4) { msg.textContent='4자 이상 입력'; msg.style.color='var(--warning)'; return; }
  if(DB.users.find(u=>u.username===val)) { msg.textContent='이미 사용 중인 아이디'; msg.style.color='var(--danger)'; return; }
  msg.textContent='✓ 사용 가능'; msg.style.color='var(--success)';
}

function autoDept(role) {
  var map = {
    hospital_director:'admin', admin:'admin',
    doctor_ortho1:'ortho1', doctor_ortho2:'ortho2',
    doctor_neuro:'neuro', doctor_internal:'internal',
    doctor_anesthesia:'anesthesia', doctor_radiology:'radiology',
    nurse:'ward', pharmacist:'pharmacy', pt_therapist:'pt',
    radiographer:'radiology', reception:'reception',
    finance_staff:'finance', claim_staff:'claim_mgmt',
    nonsurg_doctor:'nonsurg',
  };
  var deptSel = document.getElementById('cu-dept');
  if(deptSel && map[role]) {
    Array.from(deptSel.options).forEach(function(o){ o.selected = o.value === map[role]; });
  }
  // 의사 역할이면 진료시간표 섹션 표시
  var schedSec = document.getElementById('cu-schedule-section');
  var isDoctor = role.startsWith('doctor_') || role === 'hospital_director';
  if(schedSec) {
    schedSec.style.display = isDoctor ? '' : 'none';
    if(isDoctor) initScheduleTable();
  }
  // 권한 미리보기
  var perms = typeof ROLE_PERMISSIONS !== 'undefined' ? ROLE_PERMISSIONS[role] : [];
  var preview = document.getElementById('cu-perm-preview');
  var permList = document.getElementById('cu-perm-list');
  if(preview && permList && perms) {
    preview.style.display = '';
    permList.innerHTML = perms.slice(0,8).map(function(p){
      return '<span style="display:inline-block;background:#e8f0fe;color:var(--primary);border-radius:3px;padding:1px 6px;margin:2px;font-size:10px">'+p+'</span>';
    }).join('') + (perms.length>8?'<span style="font-size:10px;color:var(--text-muted)"> +' + (perms.length-8) + '개</span>':'');
  } else if(preview) {
    preview.style.display = 'none';
  }
}

function initScheduleTable() {
  var tbody = document.getElementById('cu-schedule-tbody');
  if(!tbody) return;
  var days = [
    {key:'mon', label:'월', defAm:true, defPm:true},
    {key:'tue', label:'화', defAm:true, defPm:true},
    {key:'wed', label:'수', defAm:true, defPm:true},
    {key:'thu', label:'목', defAm:true, defPm:true},
    {key:'fri', label:'금', defAm:true, defPm:true},
    {key:'sat', label:'토', defAm:true, defPm:false},
  ];
  tbody.innerHTML = days.map(function(d){
    return '<tr style="border-bottom:1px solid #f0f0f0">' +
      '<td style="padding:7px 10px;font-weight:700">' + d.label + '</td>' +
      '<td style="text-align:center;padding:7px">' +
        '<input type="checkbox" id="sched-am-'+d.key+'" ' + (d.defAm?'checked':'') + ' style="width:15px;height:15px" onchange="updateScheduleStatus(\''+d.key+'\')">' +
      '</td>' +
      '<td style="text-align:center;padding:7px">' +
        '<input type="checkbox" id="sched-pm-'+d.key+'" ' + (d.defPm?'checked':'') + ' style="width:15px;height:15px" onchange="updateScheduleStatus(\''+d.key+'\')">' +
      '</td>' +
      '<td style="text-align:center;padding:7px">' +
        '<span id="sched-status-'+d.key+'" style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:#e8f5e9;color:#2e7d32">' +
          (d.defAm&&d.defPm?'전일':d.defAm?'오전':d.defPm?'오후':'휴진') +
        '</span>' +
      '</td>' +
      '<td style="padding:7px">' +
        '<input type="text" id="sched-reason-'+d.key+'" class="form-control" style="font-size:11px;padding:4px 8px" placeholder="휴진 사유 (선택)" ' + (!d.defAm&&!d.defPm?'':'style="display:none"') + '>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function updateScheduleStatus(dayKey) {
  var am = document.getElementById('sched-am-'+dayKey);
  var pm = document.getElementById('sched-pm-'+dayKey);
  var status = document.getElementById('sched-status-'+dayKey);
  var reasonEl = document.getElementById('sched-reason-'+dayKey);
  if(!am||!pm||!status) return;
  var hasAm = am.checked, hasPm = pm.checked;
  var label, bg, color;
  if(hasAm && hasPm) { label='전일진료'; bg='#e8f5e9'; color='#2e7d32'; }
  else if(hasAm)     { label='오전진료'; bg='#e3f2fd'; color='#1565c0'; }
  else if(hasPm)     { label='오후진료'; bg='#fff8e1'; color='#f57c00'; }
  else               { label='⛔ 휴진';  bg='#ffebee'; color='#c62828'; }
  status.textContent = label;
  status.style.background = bg;
  status.style.color = color;
  if(reasonEl) reasonEl.style.display = (!hasAm && !hasPm) ? '' : 'none';
}

function collectScheduleData() {
  var days = ['mon','tue','wed','thu','fri','sat'];
  var schedule = {};
  days.forEach(function(d){
    var amEl = document.getElementById('sched-am-'+d);
    var pmEl = document.getElementById('sched-pm-'+d);
    var reason = (document.getElementById('sched-reason-'+d)||{}).value||'';
    if(!amEl) return;
    schedule[d] = {
      am: amEl.checked, pm: pmEl.checked,
      status: amEl.checked&&pmEl.checked?'all': amEl.checked?'am': pmEl.checked?'pm':'closed',
      reason: reason,
    };
  });
  return schedule;
}


function registerPatient() {
  const name = document.getElementById('pt-name').value.trim();
  const dept = document.getElementById('pt-dept').value;
  const rrn = document.getElementById('pt-rrn').value.replace(/-/g,'');
  const dob = document.getElementById('pt-dob').value;

  if(!name || !dept) { notify('입력 오류', '환자명과 진료과는 필수입니다.', 'error'); return; }

  // ─ 주민번호로 기존 환자 검색 ─
  let existingMaster = null;
  if(rrn.length >= 6) {
    existingMaster = DB.patientMaster.find(p =>
      p.rrn.replace(/-/g,'').replace(/\*/g,'').startsWith(rrn.substring(0,6)) && p.name === name
    );
  }

  let pid, visitResult;
  if(existingMaster) {
    // 기존 환자
    pid = existingMaster.pid;
    visitResult = VisitTypeEngine.determineType(pid, dept, null);
    notify('기존 환자 확인', `${name} 환자 기존 등록번호: ${pid} — ${visitResult.type}`, 'info');
  } else {
    // 신규 환자 → patientMaster에 등록
    pid = 'PT-' + new Date().getFullYear() + '-' + String(DB.patientMaster.length+1).padStart(4,'0');
    const newMaster = {
      pid, name,
      dob: dob || (rrn.length >= 6 ? rrn.substring(0,6) : '000000'),
      gender: document.getElementById('pt-gender').value || '남',
      phone: document.getElementById('pt-phone').value || '-',
      insurance: document.getElementById('pt-insurance').value,
      rrn: rrn ? rrn.substring(0,6)+'-'+rrn.substring(6,7)+'******' : '',
      address: '', regDate: new Date().toISOString().substring(0,10),
      visitHistory: []
    };
    DB.patientMaster.push(newMaster);
    visitResult = { type:'신환', reason:'신규 환자 등록', claimCode:'AA100', badge:'badge-new', color:'#2e7d32' };
  }

  const doctorEl = document.getElementById('pt-doctor');
  const pt = {
    id: pid, name,
    dob: dob || '00000000',
    gender: document.getElementById('pt-gender').value || '남',
    phone: document.getElementById('pt-phone').value || '-',
    insurance: document.getElementById('pt-insurance').value,
    dept, doctor: doctorEl ? doctorEl.value.split('(')[0] : '담당의',
    type: visitResult.type,
    visitResult,   // 판별 결과 전체 저장
    status: '대기',
    cc: '-', registered: new Date().toTimeString().substr(0,5)
  };

  // 중복 접수 방지
  if(DB.patients.find(p=>p.id===pid && p.dept===dept)) {
    notify('중복 접수', `${name} 환자는 이미 ${dept} 진료 접수되어 있습니다.`, 'warning');
    closeModal('modal-reception');
    return;
  }

  DB.patients.unshift(pt);

  // API 이벤트 발행 (부서간 연동)
  EventBus.emit('reception.new', { patient: pt, visitResult });
  API.post('/reception/queue', { pid, dept, visitType: visitResult.type });
  DB.auditLog.push({ time: new Date().toISOString(), action: 'PATIENT_REGISTERED', user: SESSION.user?.username, name: SESSION.user?.name, target: pid, ip: '192.168.1.xxx' });

  // 접수 알림 + 의사 화면 갱신
  DB.notifications.push({id:'NTF-'+Date.now(),type:'new_reservation',level:'info',
    message:'신규 접수: '+name+' ('+visitResult.type+') — '+(DEPTS[dept]?DEPTS[dept].label:dept),
    time:new Date().toISOString(),read:false});
  updateNotifBadge();
  closeModal('modal-reception');
  notify('접수 완료', `${name} 환자 접수 완료 — ${visitResult.type} (${visitResult.reason})`, 'success');
  // 의사 역할이면 외래 화면으로 자동 이동, 원무는 접수 목록 유지
  var role = SESSION.user ? SESSION.user.role : 'reception';
  var isDoc = role.startsWith('doctor_') || role === 'hospital_director';
  if(isDoc) {
    renderScreen('outpatient');
  } else {
    renderScreen('reception');
  }
}

// 접수 모달 실시간 방문유형 판별
function checkVisitType() {
  const name = document.getElementById('pt-name').value.trim();
  const rrn = document.getElementById('pt-rrn').value.replace(/-/g,'');
  const dept = document.getElementById('pt-dept').value;
  const resultEl = document.getElementById('visit-type-result');
  if(!resultEl) return;

  if(!name && rrn.length < 6) {
    resultEl.innerHTML = '';
    return;
  }

  let result = { type:'신환', reason:'신규 환자', claimCode:'AA100', badge:'badge-new', color:'#2e7d32' };

  if(rrn.length >= 6) {
    const found = DB.patientMaster.find(p =>
      p.rrn.replace(/-/g,'').replace(/\*/g,'').startsWith(rrn.substring(0,6)) && (name ? p.name===name : true)
    );
    if(found) result = VisitTypeEngine.determineType(found.pid, dept||null, null);
  } else if(name) {
    const found = DB.patientMaster.find(p => p.name === name);
    if(found) result = VisitTypeEngine.determineType(found.pid, dept||null, null);
  }

  const colorMap = { '신환':'#e8f5e9','초진':'#e3f2fd','재진':'#f3e5f5' };
  const borderMap = { '신환':'#a5d6a7','초진':'#90caf9','재진':'#ce93d8' };
  resultEl.innerHTML = `
  <div style="background:${colorMap[result.type]||'#f5f5f5'};border:1px solid ${borderMap[result.type]||'#ccc'};border-radius:6px;padding:10px 14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span class="badge ${result.badge||'badge-new'}" style="font-size:12px;padding:4px 12px">${result.type}</span>
      <span style="font-size:11px;font-weight:600;color:${result.color||'#333'}">${result.reason}</span>
      <span style="margin-left:auto;font-family:var(--mono);font-size:10px;background:#fff;padding:2px 6px;border-radius:3px;color:var(--text-muted)">청구코드: ${result.claimCode}</span>
    </div>
    <div style="font-size:11px;color:var(--text-light)">${result.detail||''}</div>
    ${result.hiraNote ? `<div style="margin-top:6px;font-size:10px;color:var(--primary);background:#fff;padding:4px 8px;border-radius:3px">📋 심평원: ${result.hiraNote}</div>` : ''}
    ${result.warning ? `<div style="margin-top:6px;font-size:10px;color:var(--warning)">${result.warning}</div>` : ''}
    ${result.pendingConfirm ? `<div style="margin-top:4px;font-size:10px;color:var(--warning)">⏳ 진료 후 상병 확정 시 최종 결정됩니다.</div>` : ''}
  </div>`;
}

// ════════════════════════════════════════════════════════
// 진료 차트 시스템 — Addendum(추가기재) 방식
//
// ■ 법적 근거: 의료법 제22조 ②항
//   "추가기재·수정된 경우 추가기재·수정된 진료기록부등 및
//    추가기재·수정 전의 원본을 모두 포함한다"
//
// ■ 핵심 원칙 (국제표준 HL7 FHIR DocuSign 방식):
//   - 원본(Original)은 절대 삭제·수정 불가 (Immutable)
//   - 수정이 필요한 경우 원본 아래에 Addendum(추가기재) 레코드를 새로 작성
//   - 최신 Addendum이 현재 유효한 내용 (현재 차트 = 원본 + 모든 Addendum)
//   - 모든 접근·수정 이력 = Audit Log에 영구 보존 (의료법 제23조)
//
// ■ 보존 기간:
//   - 진료기록부·수술기록: 10년
//   - 검사소견·방사선 사진·간호기록부: 5년
//   - 처방전: 2년
// ════════════════════════════════════════════════════════

// ── 현재 EMR 모달 상태 ──────────────────────────────────
var currentChartPid = null;
var pendingAddendumChartId = null;
var addendumPWVerified = false;

// ── 차트 헬퍼: 특정 환자의 원본 차트 조회 ───────────────
function getOriginalChart(pid) {
  // 원본 = 가장 최초에 저장된 locked 차트 (날짜 오름차순 첫 번째)
  var charts = DB.emrCharts
    .filter(function(c){ return c.ptId === pid && c.entryType === 'original' && c.status === 'locked'; })
    .sort(function(a,b){ return new Date(a.lockedAt) - new Date(b.lockedAt); });
  return charts[0] || null;
}

function getDraftChart(pid) {
  return DB.emrCharts.find(function(c){ return c.ptId === pid && c.status === 'draft'; });
}

function getAddenda(originalChartId) {
  // 특정 원본에 대한 모든 Addendum (시간 순)
  return DB.emrCharts
    .filter(function(c){ return c.originalChartId === originalChartId && c.entryType === 'addendum'; })
    .sort(function(a,b){ return new Date(a.lockedAt) - new Date(b.lockedAt); });
}

function getLatestContent(pid) {
  // 현재 유효한 내용 = 가장 최신 Addendum이 있으면 그것, 없으면 원본
  var original = getOriginalChart(pid);
  if(!original) return null;
  var addenda = getAddenda(original.chartId);
  return addenda.length > 0 ? addenda[addenda.length - 1] : original;
}

// ── openEMR (통합 진입점) ────────────────────────────────
function openEMR(pid) {
  var p = DB.patients.find(function(x){ return x.id === pid; });
  if(!p) return;
  currentChartPid = pid;

  var original = getOriginalChart(pid);
  var draft    = getDraftChart(pid);
  var addenda  = original ? getAddenda(original.chartId) : [];

  // 모달 제목
  document.getElementById('emr-pt-title').textContent =
    'EMR 진료 차트 — ' + p.name + ' (' + calcAge(p.dob) + '세 ' + p.gender + ') | ' + p.id;
  var badge = document.getElementById('emr-pt-type');
  if(badge) {
    badge.textContent = p.type;
    badge.className = 'badge ' + (p.type==='신환'?'badge-new':p.type==='초진'?'badge-first':'badge-revisit');
  }

  // 상태 배너 렌더링
  renderChartStatusBanner(original, draft, addenda);

  // 내용 채우기 (최신)
  if(original || draft) {
    var latest = draft ? draft : getLatestContent(pid);
    if(latest) fillChartContent(latest);
    lockAllChartFields(!!original && !draft);
  } else {
    clearChartFields();
    lockAllChartFields(false);
  }

  // 푸터 버튼
  updateEMRFooterButtons(original, draft);

  openModal('modal-emr');
  if(p.status === '대기') p.status = '진료중';

  // 감사 로그 — 차트 열람 기록
  DB.auditLog.push({
    time: new Date().toISOString(), action: 'CHART_VIEWED',
    user: SESSION.user ? SESSION.user.username : '-',
    name: SESSION.user ? SESSION.user.name : '-',
    patientId: pid, chartId: original ? original.chartId : 'draft'
  });

  // 영상 연동
  loadRadiologyForEMR(pid);
}

function openSurgeryRequestModal(pid) {
  var p = DB.patients.find(function(x){ return x.id === pid; });
  if(!p) return;
  
  var todayStr = new Date().toISOString().substring(0,10);
  
  // 심평원 수술행위료 목록 (건강보험 행위 급여 목록 고시 기준)
  var OP_LIST = {
    '척추 수술': [
      {c:'N2401',n:'추간판제거술-경추 (1추간)'},
      {c:'N2403',n:'추간판제거술-요추 (1추간)'},
      {c:'N2405',n:'추간판제거술-요추 미세현미경 (L4-5)'},
      {c:'N2406',n:'추간판제거술-요추 미세현미경 (L5-S1)'},
      {c:'N2407',n:'추간판제거술-경추 미세현미경 (ACDF포함)'},
      {c:'N2408',n:'추간판제거술-흉추 미세현미경'},
      {c:'N2411',n:'인공추간판치환술-경추 (1분절)'},
      {c:'N2412',n:'인공추간판치환술-경추 (2분절)'},
      {c:'N2413',n:'인공추간판치환술-요추 (1분절)'},
      {c:'N2421',n:'척추후방유합술 PLIF (1분절)'},
      {c:'N2422',n:'척추후방유합술 PLIF (2분절)'},
      {c:'N2423',n:'척추후방유합술 PLIF (3분절 이상)'},
      {c:'N2431',n:'척추전방유합술 ALIF (1분절)'},
      {c:'N2432',n:'척추전방유합술 ALIF (2분절 이상)'},
      {c:'N2441',n:'측방 추간체유합술 XLIF/LLIF (1분절)'},
      {c:'N2451',n:'척추경유추간공유합술 TLIF (1분절)'},
      {c:'N2452',n:'척추경유추간공유합술 TLIF (2분절)'},
      {c:'N2453',n:'척추경유추간공유합술 TLIF (3분절 이상)'},
      {c:'N2461',n:'척추경 나사못고정술 (2분절, 양측)'},
      {c:'N2462',n:'척추경 나사못고정술 (3분절 이상, 양측)'},
      {c:'N2471',n:'경피적 척추성형술 (1추체)'},
      {c:'N2472',n:'경피적 척추성형술 (2추체 이상)'},
      {c:'N2481',n:'척추관협착증 감압술 (편측, 1분절)'},
      {c:'N2482',n:'척추관협착증 감압술 (양측, 1분절)'},
      {c:'N2483',n:'척추관협착증 감압술 (양측, 2분절)'},
      {c:'N2491',n:'후궁절제술 (Laminectomy, 1분절)'},
      {c:'N2492',n:'반후궁절제술 (Hemilaminectomy)'},
      {c:'N2501',n:'척추측만증 교정술 (후방, 3분절 이상)'},
      {c:'N2511',n:'척추 골절 감압술 및 내고정술'},
      {c:'N2521',n:'미세침습 척추수술 (MIS-TLIF)'},
      {c:'N2531',n:'내시경 척추수술 (PELD, 경피적)'},
      {c:'N2532',n:'내시경 척추수술 (UBE, 단방향)'},
    ],
    '관절 수술': [
      {c:'N2071',n:'슬관절 전치환술 TKR (편측)'},
      {c:'N2072',n:'슬관절 전치환술 TKR (양측, 동시)'},
      {c:'N2073',n:'슬관절 부분치환술 UKA (내측)'},
      {c:'N2074',n:'슬관절 부분치환술 UKA (외측)'},
      {c:'N2075',n:'슬관절 재치환술 (revision TKR)'},
      {c:'N2081',n:'고관절 전치환술 THA (편측)'},
      {c:'N2082',n:'고관절 반치환술 (Bipolar Hemi)'},
      {c:'N2083',n:'고관절 재치환술 (revision THA)'},
      {c:'N2091',n:'견관절 전치환술 TSA'},
      {c:'N2092',n:'역형 견관절치환술 rTSA'},
      {c:'N2101',n:'반월상연골판 부분절제술 (관절경)'},
      {c:'N2102',n:'반월상연골판 봉합술 (관절경, All-inside)'},
      {c:'N2103',n:'반월상연골판 이식술 (동종)'},
      {c:'N2111',n:'전방십자인대 재건술 ACL (관절경, 자가건)'},
      {c:'N2112',n:'전방십자인대 재건술 ACL (관절경, 동종건)'},
      {c:'N2113',n:'후방십자인대 재건술 PCL (관절경)'},
      {c:'N2121',n:'슬관절 활막절제술 (관절경)'},
      {c:'N2131',n:'발목관절 유합술 (관절경)'},
      {c:'N2131',n:'발목관절 전치환술 TAR'},
      {c:'N2141',n:'견봉하 감압술 ASD (관절경)'},
      {c:'N2151',n:'회전근개 봉합술 (관절경, 부분파열)'},
      {c:'N2152',n:'회전근개 봉합술 (관절경, 완전파열 소)'},
      {c:'N2153',n:'회전근개 봉합술 (관절경, 완전파열 대·광범위)'},
      {c:'N2161',n:'SLAP 봉합술 (상방 관절순)'},
      {c:'N2171',n:'방카르트 수복술 (전방 불안정, 관절경)'},
      {c:'N2201',n:'골절 관혈적 정복 및 내고정술 (대퇴골)'},
      {c:'N2212',n:'골절 관혈적 정복 및 내고정술 (경골)'},
      {c:'N2213',n:'골절 관혈적 정복 및 내고정술 (상완골)'},
      {c:'N2221',n:'내고정물 제거술 (plate/nail)'},
    ],
    '신경외과': [
      {c:'N2301',n:'뇌종양 제거술 (두개강내, 두개강외)'},
      {c:'N2302',n:'두개강내 종양 제거술 (현미경)'},
      {c:'N2311',n:'뇌동맥류 결찰술 (개두술)'},
      {c:'N2312',n:'뇌동맥류 혈관내 코일색전술'},
      {c:'N2321',n:'경막외 혈종 제거술 (응급)'},
      {c:'N2331',n:'경막하 혈종 제거술 (만성, 천공술)'},
      {c:'N2332',n:'경막하 혈종 제거술 (급성, 개두술)'},
      {c:'N2341',n:'두개강내 압력 감시장치 삽입술'},
      {c:'N2351',n:'수두증 단락술 (V-P shunt)'},
      {c:'N2361',n:'뇌심부자극술 DBS (편측)'},
      {c:'N2371',n:'척수 종양 제거술 (경막내 수외)'},
      {c:'N2372',n:'척수 종양 제거술 (경막내 수내)'},
      {c:'N2381',n:'말초신경 봉합술'},
      {c:'N2391',n:'수근관 유리술 (손목터널증후군)'},
      {c:'N2392',n:'팔꿈치관절 척골신경 감압술'},
    ],
  };

  var bodyHtml = 
    '<div style="font-size:12px;color:var(--primary);margin-bottom:14px"><strong>수술 대상자: ' + p.name + ' (' + calcAge(p.dob) + '세 ' + p.gender + ')</strong></div>' +
    '<div class="form-group">' +
      '<label style="font-weight:700">수술 분과</label>' +
      '<select class="form-control" id="surg-dept" style="margin-bottom:8px" onchange="updateSurgeryOptions()">' +
        '<option value="">— 분과 선택 —</option>' +
        '<option value="척추 수술">척추 수술</option>' +
        '<option value="관절 수술">관절 수술</option>' +
        '<option value="신경외과">신경외과</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="font-weight:700">수술명 <small style="color:var(--text-muted);font-size:11px">(심평원 행위코드 포함)</small></label>' +
      '<select class="form-control" id="surg-name" style="margin-bottom:8px">' +
        '<option value="">— 먼저 분과를 선택하세요 —</option>' +
      '</select>' +
      '<input class="form-control" id="surg-custom" placeholder="목록에 없는 경우 입력" style="margin-top:6px;display:none" onchange="setSurgeryCodeCustom()">' +
    '</div>' +
    '<input type="hidden" id="surg-code">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<div class="form-group">' +
        '<label style="font-weight:700">수술 예정일</label>' +
        '<input class="form-control" type="date" id="surg-date" value="'+todayStr+'" onchange="updateSurgeryScheduleView(this.value)">' +
      '</div>' +
      '<div class="form-group">' +
        '<label style="font-weight:700">수술 시간</label>' +
        '<input class="form-control" type="time" id="surg-time" value="09:00">' +
      '</div>' +
    '</div>' +
    
    // 선택 날짜의 기존 수술 스케줄 표시
    '<div id="surg-schedule-view" style="margin:12px 0;padding:10px;background:#f8fafd;border:1px solid var(--border);border-radius:6px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:8px">' + todayStr + ' 수술 예약 현황</div>' +
      '<div id="surg-schedule-content" style="font-size:11px"></div>' +
    '</div>' +
    
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">' +
      '<div class="form-group">' +
        '<label style="font-weight:700">수술실</label>' +
        '<select class="form-control" id="surg-room">' +
          '<option value="OR-1">OR-1</option>' +
          '<option value="OR-2">OR-2</option>' +
          '<option value="OR-3">OR-3</option>' +
          '<option value="OR-4">OR-4</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label style="font-weight:700">담당 의사</label>' +
        '<select class="form-control" id="surg-doctor">' +
          (function(){
            var doctors = DB.users.filter(function(u){ return u.role.startsWith("doctor_") && (u.dept==="ortho1"||u.dept==="ortho2"||u.dept==="neuro"); });
            return doctors.map(function(d){ return "<option value=\""+d.name+"\">"+d.name+"</option>"; }).join("");
          })() +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:10px">' +
      '<label style="font-weight:700">마취 방법</label>' +
      '<select class="form-control" id="surg-anesthesia">' +
        '<option value="전신 마취">전신 마취</option>' +
        '<option value="척추 마취">척추 마취</option>' +
        '<option value="경막외 마취">경막외 마취</option>' +
        '<option value="국소 마취">국소 마취</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group" style="margin-top:10px">' +
      '<label style="font-weight:700">수술 예상 시간 (분)</label>' +
      '<input class="form-control" type="number" id="surg-duration" placeholder="120" value="120">' +
    '</div>' +
    '<div class="form-group" style="margin-top:10px">' +
      '<label style="font-weight:700">비고</label>' +
      '<textarea class="form-control" id="surg-note" placeholder="수술 관련 특이사항 입력" style="min-height:70px"></textarea>' +
    '</div>';
  
  openDynamicModal('modal-surgery-request',
    '<div class="modal-title">🔪 수술 요청/예약</div>',
    bodyHtml,
    '<button class="btn btn-ghost" onclick="closeModal(\'modal-surgery-request\');">취소</button>' +
    '<button class="btn btn-primary" onclick="submitSurgeryRequest(\''+pid+'\');">✓ 수술 예약</button>'
  );
  
  // OP_LIST를 전역으로 저장하고 초기화
  window.CURRENT_OP_LIST = OP_LIST;
  
  // 초기 날짜의 스케줄 표시
  setTimeout(function(){
    updateSurgeryScheduleView(todayStr);
  }, 150);
}

function updateSurgeryScheduleView(dateStr) {
  var existing = (DB.surgeries||[]).filter(function(s){ return s.date === dateStr; });
  var content = document.getElementById('surg-schedule-content');
  if(!content) return;
  
  var groupedByRoom = {};
  existing.forEach(function(s){
    if(!groupedByRoom[s.room]) groupedByRoom[s.room] = [];
    groupedByRoom[s.room].push(s);
  });
  
  if(existing.length === 0) {
    content.innerHTML = '<div style="color:var(--success);font-weight:600">✓ 이 날짜에 수술 예약이 없습니다</div>';
  } else {
    var html = '<div style="display:grid;gap:8px">';
    Object.keys(groupedByRoom).sort().forEach(function(room){
      var surgs = groupedByRoom[room];
      html += '<div style="border:1px solid #ffb3ba;border-radius:4px;padding:8px;background:#ffe8eb">' +
        '<div style="font-weight:700;color:#c2185b;margin-bottom:4px">' + room + '</div>';
      surgs.forEach(function(s){
        html += '<div style="font-size:10px;padding:4px 0;border-bottom:1px solid #ffb3ba;display:flex;justify-content:space-between">' +
          '<span><strong>' + (s.time||'미정') + '</strong> ' + s.ptName + '</span>' +
          '<span style="color:#666">' + (s.opName||'') + '</span>' +
        '</div>';
      });
      html += '</div>';
    });
    html += '</div>';
    content.innerHTML = html;
  }
}

function submitSurgeryRequest(pid) {
  var surgName = document.getElementById('surg-name').value;
  var surgCode = document.getElementById('surg-code').value;
  var customName = document.getElementById('surg-custom').value;
  
  if(!surgName && !customName) {
    notify('오류', '수술명을 선택하거나 입력하세요.', 'error');
    return;
  }
  
  if(!surgName && customName) {
    surgName = customName;
    surgCode = 'CUSTOM';
  }
  
  if(!document.getElementById('surg-date').value) {
    notify('오류', '수술 예정일은 필수입니다.', 'error');
    return;
  }
  
  var surgDate = document.getElementById('surg-date').value;
  var surgTime = document.getElementById('surg-time').value;
  var surgRoom = document.getElementById('surg-room').value;
  var surgeon = document.getElementById('surg-doctor').value || (SESSION.user ? SESSION.user.name : '미정');
  var anesthesia = document.getElementById('surg-anesthesia').value;
  var duration = parseInt(document.getElementById('surg-duration').value) || 120;
  var note = document.getElementById('surg-note').value;
  
  var p = DB.patients.find(function(x){ return x.id === pid; });
  if(!p) return;
  
  // 수술 등록
  if(!DB.surgeries) DB.surgeries = [];
  var surgery = {
    id: 'SURG-' + Date.now(),
    ptId: pid,
    ptName: p.name,
    dob: p.dob,
    opName: surgName,
    opCode: surgCode || '',
    date: surgDate,
    time: surgTime + ' (예약)',
    room: surgRoom,
    surgeon: surgeon,
    anesthesia: anesthesia,
    expectedDuration: duration,
    status: 'scheduled',
    note: note,
    requestedAt: new Date().toISOString(),
    requestedBy: SESSION.user ? SESSION.user.name : '-',
    startTime: null,
    endTime: null,
    duration: null,
    bloodLoss: null,
    complication: null
  };
  
  DB.surgeries.push(surgery);
  
  // 수술실 담당자에게 알림
  DB.notifications.push({
    id: 'NTF-' + Date.now(),
    type: 'surgery_scheduled',
    level: 'info',
    message: '새 수술 예약: ' + p.name + ' — ' + surgName + ' [' + surgCode + '] (' + surgDate + ' ' + surgTime + ')',
    time: new Date().toISOString(),
    read: false
  });
  updateNotifBadge();
  
  // 감사 로그
  DB.auditLog.push({
    time: new Date().toISOString(),
    action: 'SURGERY_REQUESTED',
    user: SESSION.user ? SESSION.user.username : '-',
    name: SESSION.user ? SESSION.user.name : '-',
    patientId: pid,
    surgeryId: surgery.id,
    surgery: surgName + ' [' + surgCode + ']',
    date: surgDate
  });
  
  closeModal('modal-surgery-request');
  closeModal('modal-emr');
  notify('수술 예약 완료', p.name + ' — ' + surgName + ' [' + surgCode + '] (' + surgDate + ' ' + surgTime + ')', 'success');
}

function updateSurgeryOptions() {
  var deptSel = document.getElementById('surg-dept');
  var dept = deptSel.value;
  var nameSel = document.getElementById('surg-name');
  var customInput = document.getElementById('surg-custom');
  
  if(!dept) {
    nameSel.innerHTML = '<option value="">— 먼저 분과를 선택하세요 —</option>';
    customInput.style.display = 'none';
    return;
  }
  
  var opList = window.CURRENT_OP_LIST || {};
  var surgeries = opList[dept] || [];
  
  var opts = '<option value="">— 수술명 선택 —</option>';
  surgeries.forEach(function(s){
    opts += '<option value="'+s.n+'" data-code="'+s.c+'">['+s.c+'] '+s.n+'</option>';
  });
  opts += '<option value="">— 목록 없는 경우 —</option>';
  
  nameSel.innerHTML = opts;
  customInput.style.display = 'none';
  document.getElementById('surg-code').value = '';
  
  nameSel.onchange = function(){
    var selIdx = this.selectedIndex;
    var selOpt = this.options[selIdx];
    if(this.value === '') {
      customInput.style.display = 'block';
      document.getElementById('surg-code').value = '';
    } else {
      customInput.style.display = 'none';
      document.getElementById('surg-code').value = selOpt.getAttribute('data-code') || '';
    }
  };
}

function setSurgeryCodeCustom() {
  document.getElementById('surg-code').value = 'CUSTOM';
}

function loadRadiologyForEMR(pid) {
  var radList = document.getElementById('emr-radiology-list');
  if(!radList) return;
  var imgs = DB.radiologyImages.filter(function(i){ return i.ptId === pid; });
  if(imgs.length === 0) {
    radList.innerHTML = '<div style="color:var(--text-muted);font-size:11px;text-align:center;padding:8px">등록된 영상 없음</div>';
    return;
  }
  radList.innerHTML = imgs.map(function(img){
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px;background:' + (img.status==='판독완료'?'#f8fafd':'#fff8f0') + ';border:1px solid ' + (img.status==='판독완료'?'var(--border)':'#ffe082') + ';border-radius:6px;cursor:pointer;margin-bottom:6px" onclick="openDicomViewer(\'' + img.id + '\')">' +
      '<div style="width:52px;height:52px;background:#111;border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="44" height="48" viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg" style="opacity:0.75">' + generateThumbSVGContent(img) + '</svg></div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">' +
          '<span class="modality-badge modality-' + img.modality.toLowerCase().replace('-','') + '" style="font-size:9px;padding:1px 5px">' + img.modality + '</span>' +
          '<span style="font-weight:700;font-size:12px">' + img.body + '</span>' +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono)">' + img.date + '</div>' +
        (img.conclusion ? '<div style="font-size:10px;color:var(--text);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📝 ' + img.conclusion + '</div>' : '<div style="font-size:10px;color:var(--warning)">⏳ 판독 대기중</div>') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">' +
        '<span class="img-status-badge ' + (img.status==='판독완료'?'img-status-done':'img-status-wait') + '" style="font-size:9px;padding:1px 7px">' + img.status + '</span>' +
        '<button class="btn btn-sm btn-primary" style="padding:3px 8px;font-size:10px" onclick="event.stopPropagation();openDicomViewer(\'' + img.id + '\')">🩻 보기</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── 차트 상태 배너 ──────────────────────────────────────
function renderChartStatusBanner(original, draft, addenda) {
  var old = document.getElementById('chart-status-banner');
  if(old) old.remove();
  var modalBody = document.querySelector('#modal-emr .modal-body');
  if(!modalBody) return;
  var banner = document.createElement('div');
  banner.id = 'chart-status-banner';

  if(!original && !draft) {
    // 신규
    banner.className = 'chart-new-banner';
    banner.innerHTML =
      '<span style="font-size:20px">📝</span>' +
      '<div><strong style="color:#1565c0;display:block">신규 차트 작성 중</strong>' +
      '<span style="font-size:11px;color:#1976d2">작성 완료 후 "🔒 최종 저장"을 누르면 이 차트는 잠기고 원본으로 보존됩니다.</span></div>';
  } else if(draft && !original) {
    banner.className = 'chart-draft-banner';
    banner.innerHTML =
      '<span style="font-size:20px">⏳</span>' +
      '<div><strong style="color:#e65100;display:block">임시 저장 상태 — 아직 잠기지 않음</strong>' +
      '<span style="font-size:11px;color:#f57c00">작성자: ' + (draft.doctor||'') + ' | ' + new Date(draft.lockedAt).toLocaleString('ko-KR') + '</span></div>';
  } else if(original) {
    var addendaCount = addenda ? addenda.length : 0;
    var lastAddendum = addenda && addenda.length > 0 ? addenda[addenda.length-1] : null;
    banner.className = 'chart-locked-banner';
    banner.innerHTML =
      '<span style="font-size:20px">🔒</span>' +
      '<div style="flex:1">' +
        '<strong style="color:#1b5e20;display:block">원본 차트 잠금 — 의료법 제22조 보존 중</strong>' +
        '<span style="font-size:11px;color:#388e3c">작성: ' + original.doctor + ' | ' + new Date(original.lockedAt).toLocaleString('ko-KR') +
        ' | 차트ID: <span style="font-family:var(--mono)">' + original.chartId + '</span>' +
        (addendaCount > 0 ? ' | <span style="color:#e65100;font-weight:700">추가기재(Addendum) ' + addendaCount + '건</span>' : '') + '</span>' +
        (lastAddendum ? '<div style="font-size:10px;color:#e65100;margin-top:3px">최신 Addendum: ' + lastAddendum.doctor + ' | ' + new Date(lastAddendum.lockedAt).toLocaleString('ko-KR') + ' | 사유: ' + (lastAddendum.addendumReason||'').substring(0,40) + '</div>' : '') +
      '</div>' +
      '<button class="btn btn-sm btn-warning no-print" onclick="openAddendumModal(\'' + original.chartId + '\')">✏ 추가기재(Addendum)</button>';
  }
  modalBody.insertBefore(banner, modalBody.firstChild);
}

// ── 필드 채우기 / 잠금 ──────────────────────────────────
function fillChartContent(chart) {
  if(!chart) return;
  var textareas = document.querySelectorAll('#modal-emr .chart-block textarea.form-control');
  if(textareas[0]) textareas[0].value = chart.soap ? (chart.soap.S||'') : '';
  if(textareas[1]) textareas[1].value = chart.soap ? (chart.soap.O||'') : '';
  if(textareas[2]) textareas[2].value = chart.soap ? (chart.soap.A||'') : '';
  if(textareas[3]) textareas[3].value = chart.soap ? (chart.soap.P||'') : '';
  var vInputs = document.querySelectorAll('#modal-emr .vital-item input, #modal-emr .vital-value');
  var v = chart.vitals || {};
  if(v.bp) { var bp = v.bp.split('/'); if(vInputs[0]) vInputs[0].value = bp[0]||''; if(vInputs[1]) vInputs[1].value = bp[1]||''; }
  if(v.hr  && vInputs[2]) vInputs[2].value = v.hr;
  if(v.bt  && vInputs[3]) vInputs[3].value = v.bt;
  if(v.rr  && vInputs[4]) vInputs[4].value = v.rr;
  if(v.spo2 && vInputs[5]) vInputs[5].value = v.spo2.replace('%','');
}

function clearChartFields() {
  document.querySelectorAll('#modal-emr .chart-block textarea.form-control').forEach(function(t){ t.value=''; });
}

function lockAllChartFields(locked) {
  document.querySelectorAll('#modal-emr .chart-block textarea.form-control, #modal-emr .vital-item input, #modal-emr .vital-value').forEach(function(f) {
    if(locked){ f.classList.add('field-locked'); f.setAttribute('readonly','readonly'); }
    else { f.classList.remove('field-locked'); f.removeAttribute('readonly'); }
  });
  document.querySelectorAll('#modal-emr .rx-remove').forEach(function(b){ b.style.display = locked?'none':''; });
  document.querySelectorAll('#modal-emr [onclick="addRx()"], #modal-emr [onclick="addRxTemplate()"]').forEach(function(b){ b.style.display = locked?'none':''; });
}

function updateEMRFooterButtons(original, draft) {
  var footer = document.querySelector('#modal-emr .modal-footer');
  if(!footer) return;
  if(original) {
    footer.innerHTML =
      '<button class="btn btn-ghost" onclick="closeModal(\'modal-emr\')">닫기</button>' +
      '<button class="btn btn-outline" onclick="openModal(\'modal-prescription\')">🖨 처방전 출력</button>' +
      '<button class="btn btn-outline" onclick="showChartHistory(\'' + original.chartId + '\')">📋 전체 차트 이력</button>' +
      '<button class="btn btn-warning" onclick="openAddendumModal(\'' + original.chartId + '\')">✏ 추가기재(Addendum)</button>' +
      '<button class="btn btn-info" onclick="openSurgeryRequestModal(\'' + currentChartPid + '\')">🔪 수술 요청</button>';
  } else {
    footer.innerHTML =
      '<button class="btn btn-ghost" onclick="closeModal(\'modal-emr\')">닫기</button>' +
      '<button class="btn btn-outline" onclick="saveDraft()">💾 임시저장</button>' +
      '<button class="btn btn-outline" onclick="openModal(\'modal-prescription\')">🖨 처방전 출력</button>' +
      '<button class="btn btn-info" onclick="openSurgeryRequestModal(\'' + currentChartPid + '\')">🔪 수술 요청</button>' +
      '<button class="btn btn-primary" onclick="saveEMR()">🔒 최종 저장 (원본 생성)</button>';
  }
}

// ── 최종 저장 (원본 생성·잠금) ──────────────────────────
function savePrescription(ptId, ptName, drugs, dept, doctorName) {
  if(!drugs||drugs.length===0){notify('오류','처방 약품이 없습니다.','error');return;}
  var prx = {
    id: 'PRX-'+Date.now(),
    ptId:ptId, ptName:ptName, dept:dept||'',
    doctor:doctorName||(SESSION.user?SESSION.user.name:'-'),
    drugs:drugs,
    status:'waiting',
    durCheck: checkDUR(drugs),
    issuedAt:new Date().toISOString(),
    dispensedAt:null, dispensedBy:null,
  };
  if(prx.durCheck.length>0) {
    prx.status = 'dur_check';
    DB.notifications.push({id:'NTF-'+Date.now(),type:'dur_warning',level:'warning',
      message:'DUR 경고: '+ptName+' — '+prx.durCheck.map(function(d){return d.drug+' '+d.type;}).join(', '),
      time:new Date().toISOString(),read:false});
    updateNotifBadge();
  }
  DB.prescriptions.push(prx);
  DB.auditLog.push({time:new Date().toISOString(),action:'PRESCRIPTION_ISSUED',
    user:SESSION.user?SESSION.user.username:'-',prxId:prx.id,ptId,drugs:drugs.length});
  notify('처방 완료','처방전이 발행되고 약제실에 전달되었습니다.'+(prx.durCheck.length>0?' ⚠ DUR 경고 있음':''),'success');
  return prx;
}

function checkDUR(drugs) {
  var warnings = [];
  var durPairs = [
    {a:'와파린',b:'아스피린',type:'상호작용'},
    {a:'디클로페낙',b:'아스피린',type:'중복투여'},
    {a:'프로포폴',b:'미다졸람',type:'중복마취'},
  ];
  (drugs||[]).forEach(function(d1){
    (drugs||[]).forEach(function(d2){
      if(d1===d2) return;
      durPairs.forEach(function(pair){
        if((d1.name.includes(pair.a)&&d2.name.includes(pair.b))||
           (d1.name.includes(pair.b)&&d2.name.includes(pair.a))){
          if(!warnings.find(function(w){return w.drug===d1.name&&w.type===pair.type;}))
            warnings.push({drug:d1.name+'+'+d2.name,type:pair.type});
        }
      });
    });
  });
  return warnings;
}


function saveEMR() {
  var pid = currentChartPid;
  var p = DB.patients.find(function(x){ return x.id===pid; });
  if(!p) return;
  var textareas = document.querySelectorAll('#modal-emr .chart-block textarea.form-control');
  var sS = textareas[0] ? textareas[0].value.trim() : '';
  var sP = textareas[3] ? textareas[3].value.trim() : '';
  if(!sS) { notify('입력 오류','S (주관적 증상) 항목을 입력하세요.','error'); return; }
  if(!sP) { notify('입력 오류','P (치료계획) 항목을 입력하세요.','error'); return; }
  if(!confirm('최종 저장하면 이 차트는 원본으로 잠기며\n의료법 제22조에 따라 10년간 보존됩니다.\n이후 수정은 Addendum(추가기재) 방식으로만 가능합니다.\n\n저장하시겠습니까?')) return;

  var vInputs = document.querySelectorAll('#modal-emr .vital-item input, #modal-emr .vital-value');
  var now = new Date().toISOString();
  var chartId = 'CHT-' + new Date().getFullYear() + '-' + String(DB.emrCharts.filter(function(c){return c.entryType==='original';}).length+1).padStart(4,'0');

  var rxItems = [];
  document.querySelectorAll('#rx-list .rx-item').forEach(function(item){
    var name = item.querySelector('.rx-name') ? item.querySelector('.rx-name').textContent : '';
    var detail = item.querySelector('.rx-detail') ? item.querySelector('.rx-detail').textContent : '';
    if(name) rxItems.push({name:name, detail:detail});
  });

  var newChart = {
    chartId: chartId,
    entryType: 'original',          // ← 원본 식별자
    originalChartId: null,           // 원본은 null
    ptId: pid,
    status: 'locked',
    lockedAt: now,
    lockedBy: SESSION.user ? SESSION.user.id : 'USR-001',
    doctor: SESSION.user ? SESSION.user.name : '담당의',
    dept: DB.currentDept,
    visitType: p.type,
    vitals: {
      bp: (vInputs[0]?vInputs[0].value:'120') + '/' + (vInputs[1]?vInputs[1].value:'80'),
      hr: vInputs[2]?vInputs[2].value:'72', bt: vInputs[3]?vInputs[3].value:'36.5',
      rr: vInputs[4]?vInputs[4].value:'16', spo2: vInputs[5]?vInputs[5].value:'98',
    },
    soap: {
      S: textareas[0]?textareas[0].value:'',
      O: textareas[1]?textareas[1].value:'',
      A: textareas[2]?textareas[2].value:'',
      P: textareas[3]?textareas[3].value:'',
    },
    icd10: [],
    prescriptions: rxItems,
    hash: btoa(encodeURIComponent(now + pid + (SESSION.user?SESSION.user.id:''))).substring(0,20),  // 무결성 해시
  };

  DB.emrCharts = DB.emrCharts.filter(function(c){ return !(c.ptId===pid && c.status==='draft'); });
  DB.emrCharts.push(newChart);

  var master = DB.patientMaster.find(function(m){ return m.pid===pid; });
  if(master) master.visitHistory.push({
    visitId:'V-'+Date.now(), date:now.substring(0,10),
    dept:DB.currentDept, doctor:newChart.lockedBy,
    icd10:'', diagName:'', visitType:p.type, note:'진료 완료',
  });

  DB.auditLog.push({ time:now, action:'CHART_LOCKED_ORIGINAL',
    user:SESSION.user?SESSION.user.username:'-', chartId, patientId:pid,
    hash: newChart.hash });

  p.status = '완료';
  closeModal('modal-emr');
  notify('차트 저장 완료', '원본 차트가 생성되었습니다. (Chart ID: ' + chartId + ')', 'success');
  EventBus.emit('emr.saved', {chartId, pid});
}

// ── 임시 저장 ──────────────────────────────────────────
function saveDraft() {
  var pid = currentChartPid;
  if(!pid) return;
  var textareas = document.querySelectorAll('#modal-emr .chart-block textarea.form-control');
  var now = new Date().toISOString();
  DB.emrCharts = DB.emrCharts.filter(function(c){ return !(c.ptId===pid && c.status==='draft'); });
  DB.emrCharts.push({
    chartId:'DFT-'+Date.now(), entryType:'original', originalChartId:null,
    ptId:pid, status:'draft', lockedAt:now,
    lockedBy:SESSION.user?SESSION.user.id:'USR-001',
    doctor:SESSION.user?SESSION.user.name:'담당의',
    dept:DB.currentDept, vitals:{}, icd10:[], prescriptions:[],
    soap:{ S:textareas[0]?textareas[0].value:'', O:textareas[1]?textareas[1].value:'',
           A:textareas[2]?textareas[2].value:'', P:textareas[3]?textareas[3].value:'' },
  });
  DB.auditLog.push({ time:now, action:'CHART_DRAFT_SAVED',
    user:SESSION.user?SESSION.user.username:'-', patientId:pid });
  notify('임시 저장','차트가 임시 저장되었습니다. 최종 저장 전까지 수정 가능합니다.','warning');
}

// ════════════════════════════════════════════════════════
// Addendum (추가기재) 시스템
// ■ 원본은 절대 수정하지 않고 아래에 새 레코드를 추가
// ■ 추가기재에도 반드시 사유 기재 + 비밀번호 인증 필요
// ■ 의료법 제22조: 원본 + 추가기재 모두 영구 보존
// ════════════════════════════════════════════════════════
function openAddendumModal(originalChartId) {
  pendingAddendumChartId = originalChartId;
  addendumPWVerified = false;
  var chart = DB.emrCharts.find(function(c){ return c.chartId===originalChartId; });
  if(!chart) return;
  var patient = DB.patientMaster.find(function(p){ return p.pid===chart.ptId; }) ||
                DB.patients.find(function(p){ return p.id===chart.ptId; });
  var addenda = getAddenda(originalChartId);

  document.getElementById('adm-chart-info').textContent =
    '차트 ID: ' + originalChartId + '  |  환자: ' + (patient?patient.name||patient.pid:chart.ptId);
  document.getElementById('adm-chart-detail').textContent =
    '원본 작성: ' + chart.doctor + ' | ' + new Date(chart.lockedAt).toLocaleString('ko-KR') +
    (addenda.length > 0 ? '  |  기존 Addendum: ' + addenda.length + '건' : '  |  첫 번째 Addendum');
  document.getElementById('adm-reason-category').value = '';
  document.getElementById('adm-reason-detail').value = '';
  document.getElementById('adm-content-s').value = '';
  document.getElementById('adm-content-a').value = '';
  document.getElementById('adm-pw').value = '';
  document.getElementById('adm-pw-status').textContent = '';
  document.getElementById('adm-warning').style.display = 'none';
  var btn = document.getElementById('adm-confirm-btn');
  if(btn){ btn.disabled=true; btn.style.opacity='0.5'; }

  // 원본 내용 미리보기 채우기
  var latest = getLatestContent(chart.ptId);
  if(latest && latest.soap) {
    document.getElementById('adm-original-preview').innerHTML =
      '<div style="font-size:10px;font-weight:700;color:var(--text-muted);margin-bottom:6px">현재 유효 내용 (원본' + (addenda.length>0?' + 최신 Addendum':'') + '):</div>' +
      '<div style="font-size:11px;line-height:1.7;padding:8px;background:#f8fafd;border-radius:4px;border:1px solid var(--border)">' +
        '<strong>S:</strong> ' + (latest.soap.S||'').substring(0,100) + (latest.soap.S && latest.soap.S.length>100?'...':'') + '<br>' +
        '<strong>A:</strong> ' + (latest.soap.A||'').substring(0,100) + (latest.soap.A && latest.soap.A.length>100?'...':'') +
      '</div>';
  }

  openModal('modal-addendum');
}

function verifyAddendumPW() {
  var pw = document.getElementById('adm-pw') ? document.getElementById('adm-pw').value : '';
  var status = document.getElementById('adm-pw-status');
  if(SESSION.user && pw === SESSION.user.password) {
    addendumPWVerified = true;
    if(status){ status.textContent='✓ 인증 완료'; status.style.color='var(--success)'; }
    checkAddendumReady();
  } else {
    addendumPWVerified = false;
    if(status){ status.textContent='✗ 비밀번호 오류'; status.style.color='var(--danger)'; }
    var btn = document.getElementById('adm-confirm-btn');
    if(btn){ btn.disabled=true; btn.style.opacity='0.5'; }
  }
}

function checkAddendumReady() {
  var cat = document.getElementById('adm-reason-category') ? document.getElementById('adm-reason-category').value : '';
  var detail = document.getElementById('adm-reason-detail') ? document.getElementById('adm-reason-detail').value.trim() : '';
  var contentS = document.getElementById('adm-content-s') ? document.getElementById('adm-content-s').value.trim() : '';
  var contentA = document.getElementById('adm-content-a') ? document.getElementById('adm-content-a').value.trim() : '';
  var warn = document.getElementById('adm-warning');
  var btn = document.getElementById('adm-confirm-btn');
  if(!btn) return;
  if(!cat||!detail||detail.length<10||(contentS+contentA).length<5) {
    if(warn&&detail.length>0&&detail.length<10) warn.style.display='block';
    btn.disabled=true; btn.style.opacity='0.5'; return;
  }
  if(warn) warn.style.display='none';
  if(addendumPWVerified){ btn.disabled=false; btn.style.opacity='1'; }
}

document.addEventListener('input', function(e) {
  if(e.target && ['adm-reason-detail','adm-reason-category','adm-content-s','adm-content-a'].indexOf(e.target.id)>=0) {
    checkAddendumReady();
  }
});

function saveAddendum() {
  var cat = document.getElementById('adm-reason-category') ? document.getElementById('adm-reason-category').value : '';
  var detail = document.getElementById('adm-reason-detail') ? document.getElementById('adm-reason-detail').value.trim() : '';
  var contentS = document.getElementById('adm-content-s') ? document.getElementById('adm-content-s').value.trim() : '';
  var contentA = document.getElementById('adm-content-a') ? document.getElementById('adm-content-a').value.trim() : '';
  var contentP = document.getElementById('adm-content-p') ? document.getElementById('adm-content-p').value.trim() : '';
  if(!cat||detail.length<10||(contentS+contentA+contentP).length<5) {
    notify('입력 오류','모든 필수 항목을 입력하세요.','error'); return;
  }
  if(!addendumPWVerified){ notify('인증 필요','비밀번호 인증을 완료하세요.','error'); return; }

  var originalChart = DB.emrCharts.find(function(c){ return c.chartId===pendingAddendumChartId; });
  if(!originalChart) return;
  var now = new Date().toISOString();

  // 기존 Addendum들에서 최신 SOAP 가져와서 합치기
  var latest = getLatestContent(originalChart.ptId);
  var prevSoap = latest ? (latest.soap||{}) : {};

  var addendumId = 'ADM-' + Date.now();

  // ★ 핵심: 새 Addendum은 원본 위에 추가만 됨. 원본 손대지 않음
  var addendum = {
    chartId: addendumId,
    entryType: 'addendum',           // ← Addendum 식별자
    originalChartId: pendingAddendumChartId,  // ← 원본 참조
    ptId: originalChart.ptId,
    status: 'locked',
    lockedAt: now,
    lockedBy: SESSION.user ? SESSION.user.id : 'USR-001',
    doctor: SESSION.user ? SESSION.user.name : '담당의',
    dept: DB.currentDept || originalChart.dept,
    addendumReason: detail,
    addendumCategory: cat,
    // Addendum에 기재된 내용 (변경된 부분만)
    soap: {
      S: contentS || prevSoap.S || '',  // 입력 없으면 이전 값 유지
      O: prevSoap.O || '',
      A: contentA || prevSoap.A || '',
      P: contentP || prevSoap.P || '',
    },
    // 이 Addendum 시점의 전체 SOAP 스냅샷 (법적 증거)
    fullSnapshot: {
      original: { chartId: pendingAddendumChartId, soap: originalChart.soap, lockedAt: originalChart.lockedAt },
      prevAddendum: latest !== originalChart ? { chartId: latest.chartId, soap: latest.soap } : null,
    },
    vitals: latest ? latest.vitals : {},
    prescriptions: latest ? latest.prescriptions : [],
    hash: btoa(encodeURIComponent(now + addendumId + (SESSION.user?SESSION.user.id:''))).substring(0,20),
  };

  DB.emrCharts.push(addendum);

  DB.auditLog.push({
    time: now, action: 'CHART_ADDENDUM_SAVED',
    user: SESSION.user?SESSION.user.username:'-',
    name: SESSION.user?SESSION.user.name:'-',
    addendumId: addendumId,
    originalChartId: pendingAddendumChartId,
    reason: detail, category: cat,
    patientId: originalChart.ptId,
  });

  closeModal('modal-addendum');
  notify('추가기재 완료', '원본 차트에 Addendum이 추가되었습니다. (ID: ' + addendumId + ')', 'success');

  // EMR 모달 새로고침
  if(originalChart.ptId) openEMR(originalChart.ptId);
}

// ── 전체 차트 이력 조회 ──────────────────────────────────
function showChartHistory(originalChartId) {
  var original = DB.emrCharts.find(function(c){ return c.chartId===originalChartId; });
  if(!original) return;
  var addenda = getAddenda(originalChartId);
  var all = [original].concat(addenda);
  var overlay = document.getElementById('modal-chart-history');
  if(!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-chart-history';
    overlay.className = 'modal-overlay open';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.classList.remove('open'); });
  }
  overlay.classList.add('open');

  var patient = DB.patientMaster.find(function(p){ return p.pid===original.ptId; }) ||
                DB.patients.find(function(p){ return p.id===original.ptId; });

  overlay.innerHTML =
    '<div class="modal" style="max-width:860px;width:96%">' +
    '<div class="modal-header"><div class="modal-title">📋 전체 차트 이력 — ' + (patient?patient.name:'') + ' (' + originalChartId + ')</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal-chart-history\').classList.remove(\'open\')">✕</button></div>' +
    '<div class="modal-body" style="padding:0;overflow-y:auto;max-height:80vh">' +

    // 법적 고지
    '<div style="background:#e3f2fd;border-bottom:1px solid #bbdefb;padding:10px 16px;font-size:11px;color:#1565c0">' +
    '⚖ <strong>의료법 제22조 보존 기록</strong> — 원본 및 모든 추가기재(Addendum)는 영구 보존됩니다. 열람 기록이 Audit Log에 저장됩니다.</div>' +

    all.map(function(entry, idx) {
      var isOriginal = entry.entryType === 'original';
      var isLatest = idx === all.length - 1;
      return '<div style="border-bottom:1px solid var(--border);padding:16px 20px">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<div style="width:28px;height:28px;border-radius:50%;background:' + (isOriginal?'var(--primary)':'#e65100') + ';color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + (isOriginal?'원':('A'+idx)) + '</div>' +
            '<div>' +
              '<div style="font-size:13px;font-weight:700;color:' + (isOriginal?'var(--primary)':'#e65100') + '">' +
                (isOriginal ? '🔒 원본 (Original)' : '✏ 추가기재 #' + idx + ' (Addendum)') +
                (isLatest && !isOriginal ? ' <span style="background:#e65100;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px">최신 유효</span>' : '') +
                (isLatest && isOriginal && all.length===1 ? ' <span style="background:var(--primary);color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px">현재 유효</span>' : '') +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' +
                '작성: <strong>' + entry.doctor + '</strong> | ' + new Date(entry.lockedAt).toLocaleString('ko-KR') +
                ' | <span style="font-family:var(--mono);font-size:10px">' + entry.chartId + '</span>' +
                (entry.hash ? ' | Hash: <span style="font-family:var(--mono);font-size:9px;color:var(--text-muted)">' + entry.hash + '</span>' : '') +
              '</div>' +
              (!isOriginal && entry.addendumReason ? '<div style="margin-top:4px;padding:4px 8px;background:#fff3e0;border-radius:3px;font-size:11px;color:#e65100"><strong>추가기재 사유:</strong> ' + entry.addendumReason + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<span class="badge ' + (isOriginal?'badge-done':'badge-warning') + '">' + (isOriginal?'원본':'Addendum') + '</span>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">' +
          '<div style="background:#f8fafd;border-radius:4px;padding:10px">' +
            '<div style="font-size:10px;font-weight:700;color:var(--text-muted);margin-bottom:6px">SOAP</div>' +
            (entry.soap ? [['S','주관적 증상'],['O','객관적 소견'],['A','진단'],['P','치료계획']].map(function(kv){
              return entry.soap[kv[0]] ? '<div style="margin-bottom:5px"><span style="font-weight:700;color:var(--primary)">[' + kv[0] + ']</span> ' + entry.soap[kv[0]].substring(0,120) + (entry.soap[kv[0]].length>120?'...':'') + '</div>' : '';
            }).join('') : '<span style="color:var(--text-muted)">내용 없음</span>') +
          '</div>' +
          '<div style="background:#f8fafd;border-radius:4px;padding:10px">' +
            '<div style="font-size:10px;font-weight:700;color:var(--text-muted);margin-bottom:6px">활력징후</div>' +
            (entry.vitals && entry.vitals.bp ? '<div>BP: ' + entry.vitals.bp + ' | HR: ' + entry.vitals.hr + ' | BT: ' + entry.vitals.bt + '°C</div>' : '<span style="color:var(--text-muted)">-</span>') +
            (entry.prescriptions && entry.prescriptions.length > 0 ? '<div style="margin-top:8px"><div style="font-size:10px;font-weight:700;color:var(--text-muted);margin-bottom:4px">처방</div>' + entry.prescriptions.slice(0,3).map(function(rx){ return '<div style="font-size:11px">• ' + (rx.name||rx) + '</div>'; }).join('') + '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('') +

    '</div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="document.getElementById(\'modal-chart-history\').classList.remove(\'open\')">닫기</button>' +
    '<button class="btn btn-outline" onclick="notify(\'출력\',\'전체 차트 이력을 출력합니다.\',\'info\')">🖨 전체 출력</button>' +
    '<button class="btn btn-warning" onclick="openAddendumModal(\'' + originalChartId + '\');document.getElementById(\'modal-chart-history\').classList.remove(\'open\')">✏ 추가기재(Addendum)</button>' +
    '</div></div>';

  // 열람 감사 로그
  DB.auditLog.push({
    time: new Date().toISOString(), action: 'CHART_HISTORY_VIEWED',
    user: SESSION.user?SESSION.user.username:'-',
    chartId: originalChartId, addendaCount: addenda.length
  });
}
function completeDispense(prxId) {
  var prx = (DB.prescriptions||[]).find(function(p){return p.id===prxId;});
  if(!prx) { notify('오류','처방을 찾을 수 없습니다.','error'); return; }
  if(prx.status==='dispensed') { notify('안내',prx.id+' 이미 조제 완료된 처방입니다.','info'); return; }

  // 약품 재고 차감
  var stockErrors = [];
  (prx.drugs||[]).forEach(function(drug){
    var inv = DB.inventory.find(function(i){return i.name.includes(drug.name)||drug.name.includes(i.name);});
    if(inv) {
      var needed = drug.qty||1;
      if(inv.qty < needed) {
        stockErrors.push(inv.name + ' 재고 부족 (' + inv.qty + '/' + needed + ')');
      } else {
        inv.qty -= needed;
        DB.stockMovements.push({
          id:'SM-'+Date.now()+Math.random().toString(36).slice(2,5),
          code:inv.code, name:inv.name, type:'out', qty:needed,
          unit:inv.unit, price:inv.price,
          reason:'조제 출고', prxId:prxId,
          createdAt:new Date().toISOString(),
          createdBy:SESSION.user?SESSION.user.id:'',
        });
        // 재고 부족 알림
        if(inv.qty < inv.min) {
          DB.notifications.push({
            id:'NTF-'+Date.now(), type:'stock_low', level:'warning',
            message:'재고 부족: '+inv.name+' '+inv.qty+inv.unit+' (최소 '+inv.min+inv.unit+')',
            time:new Date().toISOString(), read:false,
          });
        }
      }
    }
  });
  if(stockErrors.length>0) {
    notify('재고 부족', stockErrors.join(', '), 'warning');
  }

  // 처방 상태 완료
  prx.status = 'dispensed';
  prx.dispensedAt = new Date().toISOString();
  prx.dispensedBy = SESSION.user ? SESSION.user.name : '-';

  DB.auditLog.push({time:new Date().toISOString(),action:'DISPENSE_COMPLETE',
    user:SESSION.user?SESSION.user.username:'-',prxId:prxId});
  updateNotifBadge();
  notify('조제 완료', prx.ptName+' '+prx.id+' 조제 완료. 재고 자동 차감됨.', 'success');
  // 환자 호출 알림
  DB.notifications.push({
    id:'NTF-'+Date.now(), type:'pharmacy_ready', level:'info',
    message:'약 조제 완료: '+prx.ptName+' — 창구에서 수령하세요.',
    time:new Date().toISOString(), read:false,
  });
  updateNotifBadge();
  renderScreen('pharmacy');
}

function confirmDUR(prxId) {
  var prx = (DB.prescriptions||[]).find(function(p){return p.id===prxId;});
  if(!prx) { notify('오류','처방을 찾을 수 없습니다.','error'); return; }
  if(!prx.durWarning) { notify('안내','DUR 경고가 없습니다.','info'); return; }

  // DUR 확인 모달 또는 간단 확인
  if(confirm(prx.ptName + '의 DUR 경고를 확인하셨습니까?\n\n경고: ' + (prx.durMessage||'알 수 없음'))) {
    prx.status = 'dispensing';
    prx.durConfirmedAt = new Date().toISOString();
    prx.durConfirmedBy = SESSION.user ? SESSION.user.name : '-';
    DB.auditLog.push({time:new Date().toISOString(),action:'DUR_CONFIRMED',
      user:SESSION.user?SESSION.user.username:'-',prxId:prxId});
    notify('DUR 확인', prx.ptName+' DUR 확인 완료. 조제를 시작하세요.', 'info');
    renderScreen('pharmacy');
  }
}

function startDispense(prxId) {
  var prx = (DB.prescriptions||[]).find(function(p){return p.id===prxId;});
  if(!prx) { notify('오류','처방을 찾을 수 없습니다.','error'); return; }
  if(prx.status !== 'waiting') { notify('안내','이미 조제 중이거나 완료된 처방입니다.','info'); return; }

  prx.status = 'dispensing';
  prx.dispenseStartedAt = new Date().toISOString();
  prx.dispenseStartedBy = SESSION.user ? SESSION.user.name : '-';
  DB.auditLog.push({time:new Date().toISOString(),action:'DISPENSE_START',
    user:SESSION.user?SESSION.user.username:'-',prxId:prxId});
  notify('조제 시작', prx.ptName+' 조제를 시작합니다.', 'info');
  renderScreen('pharmacy');
}

function completeProcedure() { notify('시술 완료', '시술이 완료되었습니다.', 'success'); }
function cancelRecept(id) { notify('접수 취소', id + ' 접수가 취소되었습니다.', 'warning'); }
function adjustStock(code) { openStockInModal(code); }
function submitClaim() { notify('청구', '심평원 재청구를 전송합니다.', 'info'); }
function addReservation(day) { openReservationModal(day); }
function changeDiet(bed, diet) { if(DB.mealOrders && DB.mealOrders[bed]) { DB.mealOrders[bed].breakfast.dietType = diet; } }
function saveDiet(bed) { notify('식단변경', bed + ' 식단이 저장되었습니다.', 'success'); }

// ─── 접수증 출력 ─────────────────────────────────────────
function printPatientReceipt(pid) {
  var p = DB.patients.find(function(x){ return x.id===pid; });
  if(!p) return;
  var win = window.open('','_blank','width=400,height=500');
  if(!win) { notify('출력','접수증을 출력합니다.','info'); return; }
  win.document.write(
    '<html><head><title>접수증</title>' +
    '<style>body{font-family:sans-serif;font-size:12px;padding:20px;max-width:320px}' +
    'h2{text-align:center;font-size:16px;border-bottom:2px solid #000;padding-bottom:8px}' +
    '.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dotted #ccc}' +
    '.label{color:#666}.val{font-weight:600}' +
    '.footer{text-align:center;margin-top:20px;font-size:11px;color:#888}</style></head>' +
    '<body onload="window.print()">' +
    '<h2>⚕ 정동병원 접수증</h2>' +
    '<div class="row"><span class="label">접수번호</span><span class="val">' + p.id + '</span></div>' +
    '<div class="row"><span class="label">환자명</span><span class="val">' + p.name + '</span></div>' +
    '<div class="row"><span class="label">생년월일</span><span class="val">' + p.dob + '</span></div>' +
    '<div class="row"><span class="label">성별</span><span class="val">' + p.gender + '</span></div>' +
    '<div class="row"><span class="label">보험유형</span><span class="val">' + p.insurance + '</span></div>' +
    '<div class="row"><span class="label">진료과</span><span class="val">' + ({ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',health:'건강검진'}[p.dept]||p.dept) + '</span></div>' +
    '<div class="row"><span class="label">담당의</span><span class="val">' + p.doctor + '</span></div>' +
    '<div class="row"><span class="label">구분</span><span class="val">' + p.type + '</span></div>' +
    '<div class="row"><span class="label">접수시간</span><span class="val">' + p.registered + '</span></div>' +
    '<div class="row"><span class="label">접수일</span><span class="val">' + (p.regDate||new Date().toISOString().substring(0,10)) + '</span></div>' +
    '<div class="footer">정동병원 ☎ 02-1234-5678<br>서울시 중구 정동 1번지<br><br>이 접수증을 잘 보관하세요</div>' +
    '</body></html>'
  );
  win.document.close();
}

// ─── 환자 이전 기록 조회 ─────────────────────────────────
function showPatientHistory(pid) {
  var master = DB.patientMaster.find(function(m){ return m.pid===pid; });
  if(!master) { notify('이력 없음','해당 환자의 이전 기록이 없습니다.','info'); return; }
  var charts = DB.emrCharts.filter(function(c){ return c.ptId===pid && c.entryType==='original'; });
  if(charts.length === 0 && master.visitHistory.length === 0) {
    notify('이력 없음','이전 진료 기록이 없습니다.','info'); return;
  }
  // 가장 최근 원본 차트가 있으면 차트 이력 보여줌
  if(charts.length > 0) {
    showChartHistory(charts[charts.length-1].chartId);
  } else {
    notify('방문 이력','방문 이력: ' + master.visitHistory.length + '건 (차트 미작성)','info');
  }
}

// ─── ICD-10 상병코드 검색 (주요 코드 DB) ─────────────────
var ICD10_DB = [
  {code:'M54.5',name:'요통'},          {code:'M54.4',name:'요추통'},
  {code:'M51.1',name:'요추 추간판 변성'}, {code:'M51.0',name:'추간판 탈출증 (HNP)'},
  {code:'M17.1',name:'원발성 슬관절증'}, {code:'M17.0',name:'양측성 슬관절증'},
  {code:'M16.1',name:'원발성 고관절증'}, {code:'M47.8',name:'척추증'},
  {code:'M50.1',name:'경추 추간판 변성'},{code:'M50.0',name:'경추 추간판 탈출'},
  {code:'M75.1',name:'어깨 회전근개 증후군'},{code:'M75.3',name:'석회화 건염'},
  {code:'E11.9',name:'제2형 당뇨병'},   {code:'E11.0',name:'당뇨병성 케톤산증'},
  {code:'I10',  name:'본태성 고혈압'},  {code:'I11.9',name:'고혈압 심장병'},
  {code:'J06.9',name:'급성 상기도 감염'},{code:'J44.1',name:'COPD 급성 악화'},
  {code:'K21.0',name:'역류성 식도염'},  {code:'K29.7',name:'만성 위염'},
  {code:'N18.3',name:'만성 신장병 3기'},{code:'F32.1',name:'중등도 우울증'},
  {code:'M19.0',name:'원발성 다관절증'},{code:'M79.3',name:'비골막염 (윤활낭염)'},
  {code:'S32.0',name:'요추 골절'},      {code:'S22.0',name:'흉추 골절'},
  {code:'M54.2',name:'경추통'},         {code:'M48.0',name:'척추관 협착증'},
  {code:'G54.2',name:'경추 신경근병증'},{code:'G54.3',name:'흉추 신경근병증'},
];

function searchICD(query) {
  if(!query || query.length < 1) return [];
  var q = query.toUpperCase();
  return ICD10_DB.filter(function(item) {
    return item.code.toUpperCase().includes(q) || item.name.includes(query);
  }).slice(0, 8);
}

function openIcdSearch() {
  var overlay = document.getElementById('modal-icd-search');
  if(!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-icd-search';
    overlay.className = 'modal-overlay open';
    overlay.innerHTML =
      '<div class="modal" style="max-width:480px">' +
      '<div class="modal-header"><div class="modal-title">🔍 상병코드(ICD-10) 검색</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal-icd-search\').classList.remove(\'open\')">✕</button></div>' +
      '<div class="modal-body">' +
        '<input class="form-control" id="icd-search-input" placeholder="코드 또는 진단명 입력 (예: M54, 요통)" oninput="renderIcdResults(this.value)" style="margin-bottom:12px">' +
        '<div id="icd-results" style="max-height:320px;overflow-y:auto">' +
          '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px">검색어를 입력하세요</div>' +
        '</div>' +
      '</div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" onclick="document.getElementById(\'modal-icd-search\').classList.remove(\'open\')">닫기</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.classList.remove('open'); });
  }
  overlay.classList.add('open');
  setTimeout(function(){ var el=document.getElementById('icd-search-input'); if(el) el.focus(); }, 100);
}

function renderIcdResults(q) {
  var container = document.getElementById('icd-results');
  if(!container) return;
  if(!q || q.length < 1) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px">검색어를 입력하세요</div>';
    return;
  }
  var results = searchICD(q);
  if(results.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px">검색 결과 없음</div>';
    return;
  }
  container.innerHTML = results.map(function(item) {
    return '<div onclick="selectICD(\'' + item.code + '\',\'' + item.name + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background=\'#f0f4ff\'" onmouseout="this.style.background=\'#fff\'">' +
      '<span style="font-family:var(--mono);font-size:12px;font-weight:700;color:var(--primary);min-width:52px">' + item.code + '</span>' +
      '<span style="font-size:13px;font-weight:600">' + item.name + '</span>' +
      '<button class="btn btn-sm btn-primary" style="margin-left:auto;padding:3px 10px">선택</button>' +
    '</div>';
  }).join('');
}

function selectICD(code, name) {
  // EMR 모달의 진단 영역에 추가
  var aArea = document.querySelector('#modal-emr .soap-A ~ div, #modal-emr [style*="M51"]');
  var icdContainer = document.querySelector('#modal-emr .chart-block .soap-A');
  if(icdContainer) {
    var parent = icdContainer.closest('.chart-block-body');
    if(parent) {
      var tagsDiv = parent.querySelector('div[style*="margin-top:6px"]');
      if(tagsDiv) {
        var tag = document.createElement('span');
        tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#e3f2fd;border:1px solid #bbdefb;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:500;color:#1565c0;margin-right:4px;margin-bottom:4px';
        tag.innerHTML = code + ' ' + name + ' <span style="cursor:pointer;color:#999;margin-left:4px" onclick="this.parentElement.remove()">✕</span>';
        tagsDiv.appendChild(tag);
      }
    }
  }
  document.getElementById('modal-icd-search').classList.remove('open');
  notify('상병코드 추가', code + ' ' + name + ' 추가되었습니다.', 'success');
}

// ─── 처방전 출력 시 현재 환자 정보 반영 ─────────────────
function printChart() {
  var pid = currentChartPid;
  var p = pid ? DB.patients.find(function(x){ return x.id===pid; }) : null;
  if(p) {
    var nameEl = document.getElementById('prx-pt-name');
    var dobEl  = document.getElementById('prx-pt-dob');
    var docEl  = document.getElementById('prx-doctor-name');
    if(nameEl) nameEl.textContent = p.name;
    if(dobEl)  dobEl.textContent = p.dob.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3');
    if(docEl && SESSION.user) docEl.textContent = SESSION.user.name + ' (면허 ' + (SESSION.user.license||'').replace(/[^0-9]/g,'') + ')';
  }
  openModal('modal-prescription');
}
function addRx() { 
  const list = document.getElementById('rx-list');
  if(!list) return;
  const cnt = list.children.length + 1;
  const item = document.createElement('div'); item.className = 'rx-item';
  item.innerHTML = `<div class="rx-num">${cnt}</div>
  <div style="flex:1">
    <input style="border:none;background:none;font-size:12px;font-weight:600;width:100%;outline:none;font-family:var(--font)" placeholder="약품명 입력">
    <input style="border:none;background:none;font-size:11px;color:var(--text-light);width:100%;outline:none;margin-top:2px;font-family:var(--font)" placeholder="1일 n회, 식후 · n일 · 경구">
  </div>
  <button class="rx-remove" onclick="this.closest('.rx-item').remove()">✕</button>`;
  list.appendChild(item);
}
function addRxTemplate() { notify('상용처방', '자주 사용하는 처방전을 불러옵니다.', 'info'); }
function filterPatients(dept) {}

// ─── 알림 시스템 ─────────────────────────────────────────
function getUnreadNotifications() {
  return (DB.notifications||[]).filter(function(n){return !n.read;})
    .sort(function(a,b){return (b.time||'') > (a.time||'') ? 1 : -1;}).slice(0,20);
}

function markAllNotifRead() {
  (DB.notifications||[]).forEach(function(n){n.read=true;});
  renderAlertsModal();
  updateNotifBadge();
}

function updateNotifBadge() {
  var cnt = (DB.notifications||[]).filter(function(n){return !n.read;}).length;
  var badge = document.getElementById('notif-badge');
  if(badge) {
    badge.style.display = cnt > 0 ? '' : 'none';
    badge.textContent = cnt > 9 ? '9+' : String(cnt);
  }
}

function renderAlertsModal() {
  var body = document.getElementById('modal-alerts-body');
  if(!body) return;
  var notifs = (DB.notifications||[]).slice().reverse();
  var typeConfig = {
    vital_alert:    {icon:'🚨', label:'긴급',  bg:'#ffebee', border:'#ffcdd2', color:'#c62828'},
    lab_critical:   {icon:'🔬', label:'검사',  bg:'#e3f2fd', border:'#bbdefb', color:'#1565c0'},
    stock_low:      {icon:'📦', label:'재고',  bg:'#fff8e1', border:'#ffe082', color:'#f57c00'},
    new_reservation:{icon:'📅', label:'예약',  bg:'#e8f5e9', border:'#c8e6c9', color:'#2e7d32'},
    dur_warning:    {icon:'💊', label:'DUR',   bg:'#fce4ec', border:'#f48fb1', color:'#880e4f'},
    vacation_notice:{icon:'🏖', label:'휴진',  bg:'#ede7f6', border:'#b39ddb', color:'#4527a0'},
    info:           {icon:'ℹ',  label:'공지',  bg:'#e8eaf6', border:'#c5cae9', color:'#1a237e'},
  };

  if(notifs.length === 0) {
    body.innerHTML =
      '<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">' +
        '<div style="font-size:40px;margin-bottom:12px">🔔</div>' +
        '<div style="font-size:14px">새로운 알림이 없습니다</div>' +
        '<div style="font-size:11px;margin-top:6px;line-height:1.8">' +
          '활력징후 이상 · 검사 위험값 · 재고 부족 · 카카오 예약 등<br>발생 시 자동으로 표시됩니다' +
        '</div>' +
      '</div>';
    return;
  }

  function notifItem(n) {
    var cfg = typeConfig[n.type] || typeConfig.info;
    return '<div onclick="(function(){n.read=true;renderAlertsModal();updateNotifBadge();})()" ' +
      'style="padding:12px 16px;border-bottom:1px solid #f5f5f5;cursor:pointer;background:' + (n.read?'#fff':cfg.bg) + '">' +
      '<div style="display:flex;align-items:flex-start;gap:10px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + cfg.bg + ';border:1.5px solid ' + cfg.border + ';' +
             'display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">' + cfg.icon + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">' +
            '<span style="font-size:10px;font-weight:700;padding:1px 6px;background:' + cfg.bg + ';color:' + cfg.color + ';border-radius:3px;border:1px solid ' + cfg.border + '">' + cfg.label + '</span>' +
            (n.read ? '' : '<span style="width:6px;height:6px;border-radius:50%;background:#e53935;display:inline-block" title="읽지 않음"></span>') +
          '</div>' +
          '<div style="font-size:12px;font-weight:' + (n.read?'400':'600') + ';color:' + (n.read?'var(--text-muted)':'inherit') + '">' +
            n.message.substring(0,80) + (n.message.length>80?'...':'') +
          '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);margin-top:3px">' +
            (n.time||'').substring(0,16).replace('T',' ') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  var unread = notifs.filter(function(n){return !n.read;});
  var read   = notifs.filter(function(n){return n.read;});
  var html = '';

  if(unread.length > 0) {
    html += '<div style="padding:8px 16px;background:#f8f9fa;font-size:10px;font-weight:700;' +
            'color:var(--text-muted);letter-spacing:0.5px;border-bottom:1px solid #f0f0f0">' +
            '읽지 않은 알림 ' + unread.length + '개</div>';
    html += unread.map(notifItem).join('');
  }
  if(read.length > 0) {
    html += '<div style="padding:8px 16px;background:#f8f9fa;font-size:10px;font-weight:700;' +
            'color:var(--text-muted);letter-spacing:0.5px;border-bottom:1px solid #f0f0f0">' +
            '읽은 알림</div>';
    html += read.slice(0,10).map(notifItem).join('');
  }
  body.innerHTML = html;
}

function showAllNotifications() {
  renderAlertsModal();
  openModal('modal-alerts');
}

// 알림 badge 1초마다 업데이트
setInterval(updateNotifBadge, 1000);


function showAlerts() { renderAlertsModal(); openModal('modal-alerts'); }
function openRadiologyFromEMR() { notify('영상 의뢰', '영상의학과 촬영 의뢰를 전송합니다.', 'info'); }

// ─── GLOBAL SEARCH ──────────────────────────────────────
function globalSearch(q) {
  if(!q || q.length < 1) { hideSearchResults(); return; }
  const results = DB.patients.filter(p =>
    p.name.includes(q) || p.id.includes(q) || p.dob.includes(q) || p.phone.replace(/-/g,'').includes(q.replace(/-/g,''))
  ).slice(0, 6);
  showSearchResults(results, q);
}
function showSearchResults(results, q) {
  let drop = document.getElementById('global-search-drop');
  const wrap = document.querySelector('.topbar-search');
  if(!drop) {
    drop = document.createElement('div');
    drop.id = 'global-search-drop';
    drop.className = 'search-results';
    drop.style.cssText = 'position:absolute;top:56px;left:200px;right:auto;width:360px;background:#fff;border:1px solid var(--border);border-radius:0 0 8px 8px;box-shadow:0 8px 24px rgba(0,0,0,0.12);z-index:600;max-height:280px;overflow-y:auto';
    document.getElementById('topbar').appendChild(drop);
  }
  if(results.length === 0) {
    drop.innerHTML = '<div style="padding:14px 16px;font-size:12px;color:var(--text-muted);text-align:center">검색 결과 없음</div>';
  } else {
    drop.innerHTML = results.map(p => `
    <div onclick="openEMR('${p.id}');hideSearchResults()" style="padding:10px 14px;cursor:pointer;display:flex;gap:10px;align-items:center;border-bottom:1px solid #f0f2f5;transition:background 0.1s" onmouseover="this.style.background='#f8fafd'" onmouseout="this.style.background='#fff'">
      <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;flex-shrink:0">${p.name[0]}</div>
      <div style="flex:1">
        <div style="font-size:12px;font-weight:700">${p.name} <span style="color:var(--text-muted);font-weight:400">${p.gender} · ${calcAge(p.dob)}세</span></div>
        <div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);margin-top:1px">${p.id} | ${p.insurance} | ${p.phone}</div>
      </div>
      <span class="badge ${p.type==='신환'?'badge-new':p.type==='초진'?'badge-first':'badge-revisit'}">${p.type}</span>
    </div>`).join('');
  }
  drop.style.display = 'block';
}
function hideSearchResults() {
  const drop = document.getElementById('global-search-drop');
  if(drop) drop.style.display = 'none';
}
document.addEventListener('click', e => {
  if(!e.target.closest('.topbar-search')) hideSearchResults();
});

// ─── USER MANAGEMENT SCREEN ─────────────────────────────
function renderUserManagement(el) {
  // 권한 확인
  if(SESSION.user && !['admin','hospital_director'].includes(SESSION.user.role)) {
    el.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted)">
      <div style="font-size:48px;margin-bottom:12px">🔒</div>
      <div style="font-size:14px;font-weight:600">접근 권한이 없습니다</div>
      <div style="font-size:12px;margin-top:6px">관리자 또는 병원장만 접근 가능합니다.</div>
    </div>`;
    return;
  }

  const roleLabels = {
    admin:'시스템 관리자', hospital_director:'병원장',
    doctor_ortho1:'정형외과1 전문의', doctor_ortho2:'정형외과2 전문의',
    doctor_neuro:'신경외과 전문의', doctor_internal:'내과 전문의',
    doctor_radiology:'영상의학과 전문의', nonsurg_doctor:'비수술치료 의사',
    nurse:'간호사', reception:'원무', pharmacist:'약사',
    pt_therapist:'물리치료사', radiographer:'방사선사',
  };
  const roleColors = {
    admin:'#37474f', hospital_director:'#b71c1c',
    doctor_ortho1:'#1a4fa0', doctor_ortho2:'#1565c0', doctor_neuro:'#4527a0',
    doctor_internal:'#00695c', doctor_radiology:'#546e7a', nonsurg_doctor:'#6a1b9a',
    nurse:'#0277bd', reception:'#795548', pharmacist:'#2e7d32',
    pt_therapist:'#e65100', radiographer:'#546e7a',
  };

  el.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div class="section-title" style="margin:0">🔑 사용자 계정 관리</div>
    <div class="btn-group">
      <select class="form-control" style="width:auto" id="user-filter-role" onchange="filterUsers()">
        <option value="">전체 직군</option>
        ${Object.entries(roleLabels).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
      </select>
      <select class="form-control" style="width:auto" id="user-filter-status" onchange="filterUsers()">
        <option value="">전체 상태</option><option value="active">활성</option><option value="inactive">비활성</option>
      </select>
      <button class="btn btn-primary" onclick="openCreateUserModal()">+ 계정 생성</button>
      <button class="btn btn-outline" onclick="exportUsers()">📊 내보내기</button>
      <button class="btn btn-ghost" onclick="renderHandoverHistory(document.getElementById('screen-users'))">🔄 인수인계 이력</button>
    </div>
  </div>

  <!-- 통계 -->
  <div class="grid-4" style="margin-bottom:16px">
    <div class="stat-card blue"><div class="stat-label">전체 계정</div><div class="stat-value">${DB.users.length}</div></div>
    <div class="stat-card green"><div class="stat-label">활성 계정</div><div class="stat-value">${DB.users.filter(u=>u.status==='active').length}</div></div>
    <div class="stat-card orange"><div class="stat-label">의사 계정</div><div class="stat-value">${DB.users.filter(u=>u.role.startsWith('doctor')||u.role==='hospital_director').length}</div></div>
    <div class="stat-card red"><div class="stat-label">관리자 계정</div><div class="stat-value">${DB.users.filter(u=>['admin','hospital_director'].includes(u.role)).length}</div></div>
  </div>

  <!-- 권한 안내 -->
  <div style="background:#e8f0fe;border:1px solid #c5cae9;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:11px">
    <div style="font-weight:700;color:var(--primary);margin-bottom:6px">🔑 계정 권한 체계</div>
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      <div><strong style="color:#b71c1c">병원장</strong> — 전체 시스템 접근 (관리자와 동등)</div>
      <div><strong style="color:#37474f">관리자</strong> — 전체 시스템 접근 (계정 생성/관리 포함)</div>
      <div><strong style="color:#1a4fa0">진료과 의사</strong> — EMR·처방·영상·검사·병동 조회</div>
      <div><strong style="color:#0277bd">간호사</strong> — 병동·간호기록·투약·검사 결과</div>
      <div><strong style="color:#795548">원무</strong> — 접수·수납·예약·동의서</div>
    </div>
  </div>

  <!-- 계정 목록 -->
  <div class="card" id="user-list-card">
    <div class="tbl-wrap">
      <table id="user-table">
        <thead><tr>
          <th>계정 ID</th><th>아이디</th><th>이름</th><th>직책/권한</th>
          <th>부서</th><th>면허번호</th><th>연락처</th>
          <th>생성자</th><th>마지막 로그인</th><th>상태</th><th>관리</th>
        </tr></thead>
        <tbody id="user-tbody">
          ${renderUserRows(DB.users)}
        </tbody>
      </table>
    </div>
  </div>

  <!-- 감사 로그 -->
  <div class="card" style="margin-top:16px">
    <div class="card-header">
      <div class="card-title">📋 접속 감사 로그 (Audit Log)</div>
      <button class="btn btn-sm btn-ghost" onclick="renderUserManagement(document.getElementById('screen-users'))">새로고침</button>
    </div>
    <div style="overflow-x:auto;max-height:200px;overflow-y:auto">
      <table>
        <thead><tr><th>시간</th><th>액션</th><th>아이디</th><th>이름</th><th>IP</th></tr></thead>
        <tbody>
          ${[...DB.auditLog].reverse().slice(0,20).map(log=>`<tr>
            <td style="font-family:var(--mono);font-size:10px">${log.time.substring(0,19).replace('T',' ')}</td>
            <td><span class="badge ${log.action.includes('FAIL')?'badge-urgent':log.action.includes('SUCCESS')?'badge-done':'badge-first'}" style="font-size:9px">${log.action}</span></td>
            <td style="font-family:var(--mono);font-size:11px">${log.user||'-'}</td>
            <td style="font-size:11px">${log.name||'-'}</td>
            <td style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">${log.ip||'-'}</td>
          </tr>`).join('')}
          ${DB.auditLog.length===0?'<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:12px">로그 없음</td></tr>':''}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderUserRows(users) {
  const roleLabels = {
    admin:'시스템 관리자', hospital_director:'병원장',
    doctor_ortho1:'정형외과1 의사', doctor_ortho2:'정형외과2 의사',
    doctor_neuro:'신경외과 원장', doctor_internal:'내과·건강검진 원장',
    doctor_radiology:'진단영상의학과 원장', doctor_anesthesia:'마취통증의학과 원장', nurse:'간호사',
    reception:'원무', pharmacist:'약사', pt_therapist:'물리치료사', radiographer:'방사선사',
    finance_staff:'재무', claim_staff:'심사청구',
  };
  const roleColors = {
    admin:'#455a64', hospital_director:'#b71c1c',
    doctor_ortho1:'#1a4fa0', doctor_ortho2:'#1565c0', doctor_neuro:'#4527a0',
    doctor_internal:'#00695c', nurse:'#0277bd', reception:'#795548',
    pharmacist:'#2e7d32', pt_therapist:'#e65100', radiographer:'#546e7a',
    finance_staff:'#1b5e20', claim_staff:'#4a148c',
  };
  const deptNames = {ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',
    ward:'병동',pharmacy:'약제실',reception:'원무팀',pt:'물리치료',radiology:'영상의학과',
    admin:'관리',health:'건강검진',finance:'재무과',claim_mgmt:'심사청구과'};

  return users.map(u => {
    // 진료 이력이 있는 의사인지 확인 (삭제 불가 여부 결정)
    const hasCharts = DB.emrCharts.some(c => c.lockedBy === u.id);
    const hasVisits = DB.patientMaster.some(p => p.visitHistory.some(v => v.doctor === u.id));
    const isDeletable = !hasCharts && !hasVisits && !['admin','hospital_director'].includes(u.role);
    const color = roleColors[u.role] || '#9e9e9e';

    return '<tr id="urow-' + u.id + '" style="' + (u.status!=='active'?'opacity:0.65':'') + '">' +
      '<td style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">' + u.id + '</td>' +
      '<td><strong style="font-family:var(--mono)">' + u.username + '</strong></td>' +
      '<td><div style="display:flex;align-items:center;gap:7px">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:' + color + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;flex-shrink:0">' + u.name[0] + '</div>' +
        '<span style="font-weight:600">' + u.name + '</span>' +
      '</div></td>' +
      '<td><span style="display:inline-flex;align-items:center;gap:4px;background:' + color + '22;color:' + color + ';padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">' + (roleLabels[u.role]||u.role) + '</span></td>' +
      '<td style="font-size:11px">' + (deptNames[u.dept]||u.dept) + '</td>' +
      '<td style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">' + (u.license||'-') + '</td>' +
      '<td style="font-size:11px">' + u.phone + '</td>' +
      '<td style="font-size:10px;color:var(--text-muted)">' + ((DB.users.find(x=>x.id===u.createdBy)||{}).name || u.createdBy) + '</td>' +
      '<td style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">' + (u.lastLogin||'-') + '</td>' +
      '<td><span class="badge ' + (u.status==='active'?'badge-done':'badge-cancel') + '">' + (u.status==='active'?'활성':'비활성') + '</span></td>' +
      '<td><div class="btn-group" style="flex-wrap:nowrap">' +
        '<button class="btn btn-sm btn-outline" onclick="openEditUserModal(\'' + u.id + '\')">수정</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="resetPassword(\'' + u.id + '\')">비번초기화</button>' +
        '<button class="btn btn-sm ' + (u.status==='active'?'btn-warning':'btn-success') + '" style="padding:3px 8px;font-size:10px" onclick="toggleUserStatus(\'' + u.id + '\')">' + (u.status==='active'?'비활성화':'활성화') + '</button>' +
        '<button class="btn btn-sm btn-danger" style="padding:3px 8px;font-size:10px" onclick="requestDeleteUser(\'' + u.id + '\')" ' +
          (isDeletable ? '' : 'disabled title="' + (['admin','hospital_director'].includes(u.role) ? '관리자/병원장은 삭제 불가' : '진료 이력이 있어 삭제 불가 (의료법 보존 의무)') + '"') +
          '>삭제</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

// ─── 계정 삭제 시스템 ────────────────────────────────────
function requestDeleteUser(uid) {
  const user = DB.users.find(u => u.id === uid);
  if (!user) return;

  // 삭제 불가 조건 재확인
  if (['admin', 'hospital_director'].includes(user.role)) {
    notify('삭제 불가', '관리자 및 병원장 계정은 삭제할 수 없습니다.', 'error'); return;
  }
  const hasCharts = DB.emrCharts.some(c => c.lockedBy === uid);
  const hasVisits = DB.patientMaster.some(p => p.visitHistory.some(v => v.doctor === uid));
  if (hasCharts || hasVisits) {
    notify('삭제 불가', '진료 이력이 있는 계정은 의료법 제22조에 따라 삭제할 수 없습니다. 비활성화를 사용하세요.', 'error'); return;
  }
  // 본인 계정 삭제 불가
  if (SESSION.user && SESSION.user.id === uid) {
    notify('삭제 불가', '현재 로그인 중인 본인 계정은 삭제할 수 없습니다.', 'error'); return;
  }

  // 삭제 확인 모달 열기
  const overlay = document.getElementById('modal-delete-user');
  if (!overlay) return;

  document.getElementById('del-user-name').textContent = user.name;
  document.getElementById('del-user-info').textContent =
    user.username + ' | ' + (user.role) + ' | ' + user.dept + ' | 입사: ' + user.joinDate;
  document.getElementById('del-confirm-input').value = '';
  document.getElementById('del-confirm-btn').disabled = true;
  document.getElementById('del-confirm-btn').style.opacity = '0.5';
  document.getElementById('del-confirm-btn').onclick = function() { confirmDeleteUser(uid); };
  document.getElementById('del-user-name-hint').textContent = user.name;
  overlay.classList.add('open');
}

function checkDeleteConfirm(val) {
  const nameEl = document.getElementById('del-user-name');
  const btn = document.getElementById('del-confirm-btn');
  if (!nameEl || !btn) return;
  const match = val.trim() === nameEl.textContent.trim();
  btn.disabled = !match;
  btn.style.opacity = match ? '1' : '0.5';
}

function confirmDeleteUser(uid) {
  const user = DB.users.find(u => u.id === uid);
  if (!user) return;

  const name = user.name;
  const username = user.username;

  // DB에서 완전 제거
  DB.users = DB.users.filter(u => u.id !== uid);

  // 감사 로그 — 삭제는 영구적이므로 반드시 기록
  DB.auditLog.push({
    time: new Date().toISOString(),
    action: 'USER_DELETED',
    user: SESSION.user ? SESSION.user.username : '-',
    name: SESSION.user ? SESSION.user.name : '-',
    target: username,
    targetName: name,
    targetId: uid,
    ip: '192.168.1.xxx',
    note: '관리자에 의한 계정 영구 삭제'
  });

  document.getElementById('modal-delete-user').classList.remove('open');
  notify('계정 삭제 완료', name + ' (' + username + ') 계정이 영구 삭제되었습니다.', 'success');
  renderScreen('users');
}

function filterUsers() {
  const role = document.getElementById('user-filter-role')?.value || '';
  const status = document.getElementById('user-filter-status')?.value || '';
  const filtered = DB.users.filter(u =>
    (!role || u.role === role) && (!status || u.status === status)
  );
  const tbody = document.getElementById('user-tbody');
  if(tbody) tbody.innerHTML = renderUserRows(filtered);
}

function openCreateUserModal() { openModal('modal-create-user'); resetCreateUserForm(); }
function openEditUserModal(uid) {
  const user = DB.users.find(u => u.id === uid);
  if(!user) return;
  // 수정 모달 (생성 모달 재활용)
  openModal('modal-create-user');
  document.getElementById('cu-modal-title').textContent = '✏ 계정 수정 — ' + user.name;
  document.getElementById('cu-username').value = user.username;
  document.getElementById('cu-name').value = user.name;
  document.getElementById('cu-role').value = user.role;
  document.getElementById('cu-dept').value = user.dept;
  document.getElementById('cu-email').value = user.email;
  document.getElementById('cu-phone').value = user.phone;
  document.getElementById('cu-license').value = user.license;
  document.getElementById('cu-joindate').value = user.joinDate;
  document.getElementById('cu-spec').value = user.spec || '';
  document.getElementById('cu-save-btn').onclick = () => saveEditUser(uid);
  document.getElementById('cu-pw').placeholder = '변경 시에만 입력 (빈칸=유지)';
}
function resetCreateUserForm() {
  document.getElementById('cu-modal-title').textContent = '+ 새 계정 생성';
  ['cu-username','cu-name','cu-email','cu-phone','cu-license','cu-spec'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  document.getElementById('cu-role').value = '';
  document.getElementById('cu-dept').value = '';
  document.getElementById('cu-joindate').value = new Date().toISOString().substring(0,10);
  document.getElementById('cu-pw').placeholder = '비밀번호 (8자 이상, 영문+숫자+특수문자)';
  document.getElementById('cu-save-btn').onclick = saveCreateUser;
}
function saveCreateUser() {
  const username = document.getElementById('cu-username').value.trim();
  const name = document.getElementById('cu-name').value.trim();
  const role = document.getElementById('cu-role').value;
  const dept = document.getElementById('cu-dept').value;
  const pw = document.getElementById('cu-pw').value;

  if(!username||!name||!role||!dept||!pw) { notify('입력 오류','필수 항목을 모두 입력하세요.','error'); return; }
  if(DB.users.find(u=>u.username===username)) { notify('중복 오류','이미 사용 중인 아이디입니다.','error'); return; }
  if(pw.length < 8) { notify('보안 오류','비밀번호는 8자 이상이어야 합니다.','error'); return; }

  const newUser = {
    id: 'USR-' + String(DB.users.length+1).padStart(3,'0'),
    username, password: pw, name, role, dept,
    email: document.getElementById('cu-email').value,
    phone: document.getElementById('cu-phone').value,
    license: document.getElementById('cu-license').value,
    joinDate: document.getElementById('cu-joindate').value,
    spec: document.getElementById('cu-spec').value,
    status: 'active', permissions: [],
    lastLogin: '-', createdBy: SESSION.user?.id || 'USR-001',
    schedule: (document.getElementById('cu-schedule-section') &&
               document.getElementById('cu-schedule-section').style.display!=='none')
              ? collectScheduleData() : null,
  };
  DB.users.push(newUser);
  DB.auditLog.push({ time: new Date().toISOString(), action: 'USER_CREATED', user: SESSION.user?.username, name: SESSION.user?.name, target: username, ip: '192.168.1.xxx' });
  closeModal('modal-create-user');
  notify('계정 생성 완료', `${name} (${username}) 계정이 생성되었습니다.`, 'success');
  // 의사 휴진 알림 생성
  if(newUser.schedule) {
    var closedDays = Object.entries(newUser.schedule).filter(function(e){return e[1].status==='closed';});
    if(closedDays.length > 0) {
      var dayLabel = {mon:'월',tue:'화',wed:'수',thu:'목',fri:'금',sat:'토'};
      closedDays.forEach(function(e){
        DB.notifications.push({
          id:'NTF-'+Date.now()+Math.random(),
          type:'vacation_notice', level:'info',
          message:'휴진 등록: '+name+' '+dayLabel[e[0]]+'요일 휴진' + (e[1].reason?' ('+e[1].reason+')':''),
          time:new Date().toISOString(), read:false,
        });
      });
      updateNotifBadge();
    }
  }
  renderScreen('users');
}
function saveEditUser(uid) {
  const user = DB.users.find(u => u.id === uid);
  if(!user) return;
  user.name = document.getElementById('cu-name').value || user.name;
  user.role = document.getElementById('cu-role').value || user.role;
  user.dept = document.getElementById('cu-dept').value || user.dept;
  user.email = document.getElementById('cu-email').value || user.email;
  user.phone = document.getElementById('cu-phone').value || user.phone;
  user.license = document.getElementById('cu-license').value;
  user.spec = document.getElementById('cu-spec').value;
  const newPw = document.getElementById('cu-pw').value;
  if(newPw && newPw.length >= 8) user.password = newPw;
  DB.auditLog.push({ time: new Date().toISOString(), action: 'USER_EDITED', user: SESSION.user?.username, name: SESSION.user?.name, target: user.username, ip: '192.168.1.xxx' });
  closeModal('modal-create-user');
  notify('수정 완료', `${user.name} 계정이 수정되었습니다.`, 'success');
  renderScreen('users');
}
function toggleUserStatus(uid) {
  const user = DB.users.find(u => u.id === uid);
  if(!user) return;
  if(['admin','hospital_director'].includes(user.role) && SESSION.user?.id !== 'USR-001') {
    notify('권한 오류','관리자/병원장 계정은 최고관리자만 비활성화할 수 있습니다.','error'); return;
  }

  if(user.status === 'active') {
    // 활성 → 비활성: 의사라면 퇴사 처리 모달, 아니면 바로 비활성
    const isDoctor = user.role.startsWith('doctor') || user.role === 'hospital_director';
    const hasPatients = DB.patientMaster.some(p => p.visitHistory.some(v => v.doctor === uid));
    if(isDoctor && hasPatients) {
      openResignationModal(uid);  // 인수인계 필요
      return;
    }
    // 의사가 아니거나 환자 없으면 바로 비활성
    user.status = 'inactive';
    user.resignedAt = new Date().toISOString();
    DB.auditLog.push({ time:new Date().toISOString(), action:'USER_DEACTIVATED', user:SESSION.user?.username, target:user.username, ip:'192.168.1.xxx' });
    notify('비활성화', user.name + ' 계정이 비활성화되었습니다.', 'warning');
    renderScreen('users');
  } else {
    // 비활성 → 활성 (복직)
    user.status = 'active';
    delete user.resignedAt;
    delete user.handoverTo;
    DB.auditLog.push({ time:new Date().toISOString(), action:'USER_REACTIVATED', user:SESSION.user?.username, target:user.username, ip:'192.168.1.xxx' });
    notify('활성화', user.name + ' 계정이 다시 활성화되었습니다.', 'success');
    renderScreen('users');
  }
}

// ════════════════════════════════════════════════════════
// 의사 퇴사 & 환자 인수인계 시스템
//
// ■ 원칙:
//   1. 퇴사 의사의 과거 차트는 원본 그대로 영구 보존 (의료법 제22조)
//      → 차트에 기재된 작성의사명·서명은 절대 변경 불가
//   2. 인수인계는 "신규 담당의 지정" 이벤트로 별도 기록
//      → DB.patientMaster[].currentDoctor 필드 업데이트
//      → 인수인계 확인 Addendum이 해당 환자 차트에 추가됨
//   3. 신규 의사는 이전 차트 열람 가능, 수정 불가
//   4. 향후 신규 진료는 신규 의사 명의로 새 차트 생성
// ════════════════════════════════════════════════════════

let pendingResignationUid = null;

function openResignationModal(uid) {
  pendingResignationUid = uid;
  const user = DB.users.find(u => u.id === uid);
  if(!user) return;

  // 해당 의사의 환자 목록 파악
  const myPatients = DB.patientMaster.filter(p =>
    p.visitHistory.some(v => v.doctor === uid)
  );
  const myCharts = DB.emrCharts.filter(c => c.lockedBy === uid && c.entryType === 'original');

  // 같은 진료과 의사 목록 (인수받을 수 있는 의사)
  const sameDeptDoctors = DB.users.filter(u =>
    u.id !== uid &&
    u.status === 'active' &&
    (u.role.startsWith('doctor') || u.role === 'hospital_director') &&
    u.dept === user.dept
  );

  const overlay = document.getElementById('modal-resignation');
  if(!overlay) return;

  document.getElementById('resign-doctor-name').textContent = user.name;
  document.getElementById('resign-doctor-info').textContent =
    ({doctor_ortho1:'정형외과1',doctor_ortho2:'정형외과2',doctor_neuro:'신경외과',doctor_internal:'내과',doctor_radiology:'영상의학과'}[user.role]||user.dept) +
    ' | 입사: ' + user.joinDate + ' | 보유 환자: ' + myPatients.length + '명 | 차트: ' + myCharts.length + '건';

  // 인수의사 선택 드롭다운
  const select = document.getElementById('resign-handover-to');
  if(select) {
    select.innerHTML = '<option value="">인수 의사 선택 (필수)</option>' +
      (sameDeptDoctors.length > 0
        ? sameDeptDoctors.map(d => '<option value="' + d.id + '">' + d.name + ' (' + ({doctor_ortho1:'정형외과1',doctor_ortho2:'정형외과2',doctor_neuro:'신경외과',doctor_internal:'내과',doctor_radiology:'영상의학과',hospital_director:'병원장'}[d.role]||d.dept) + ')</option>').join('')
        : '<option value="EXTERNAL" style="color:var(--warning)">⚠ 동일 진료과 의사 없음 (신규 채용 후 처리)</option>'
      );
  }

  // 환자 목록 미리보기
  const preview = document.getElementById('resign-patient-list');
  if(preview) {
    if(myPatients.length === 0) {
      preview.innerHTML = '<div style="color:var(--text-muted);font-size:11px;text-align:center;padding:8px">인수인계할 환자 없음</div>';
    } else {
      preview.innerHTML = myPatients.slice(0,5).map(p => {
        const lastV = p.visitHistory[p.visitHistory.length-1];
        return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f5f5f5;font-size:11px">' +
          '<strong style="min-width:50px">' + p.name + '</strong>' +
          '<span style="color:var(--text-muted)">' + p.dob.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + '</span>' +
          '<span style="flex:1;color:var(--text-muted)">' + (lastV ? lastV.diagName || lastV.icd10 : '-') + '</span>' +
          '<span style="font-family:var(--mono);font-size:10px;color:var(--primary)">' + p.visitHistory.length + '회 내원</span>' +
        '</div>';
      }).join('') +
      (myPatients.length > 5 ? '<div style="font-size:10px;color:var(--text-muted);text-align:right;padding-top:4px">... 외 ' + (myPatients.length-5) + '명</div>' : '');
    }
  }

  document.getElementById('resign-note').value = '';
  document.getElementById('resign-effective-date').value = new Date().toISOString().substring(0,10);
  overlay.classList.add('open');
}

function confirmResignation() {
  const uid = pendingResignationUid;
  const user = DB.users.find(u => u.id === uid);
  if(!user) return;

  const handoverToId = document.getElementById('resign-handover-to')?.value;
  const effectiveDate = document.getElementById('resign-effective-date')?.value || new Date().toISOString().substring(0,10);
  const note = document.getElementById('resign-note')?.value.trim() || '';

  if(!handoverToId) { notify('입력 오류','인수 의사를 선택하세요.','error'); return; }

  const handoverTo = DB.users.find(u => u.id === handoverToId);
  const handoverName = handoverTo ? handoverTo.name : '미정 (신규 채용 예정)';

  // 1. 퇴사 의사 비활성화 처리
  user.status = 'inactive';
  user.resignedAt = effectiveDate;
  user.handoverTo = handoverToId;
  user.resignNote = note;

  // 2. 인수인계 이력 DB에 기록
  if(!DB.handoverRecords) DB.handoverRecords = [];
  const handoverRecord = {
    id: 'HO-' + Date.now(),
    fromDoctorId:   uid,
    fromDoctorName: user.name,
    toDoctorId:     handoverToId,
    toDoctorName:   handoverName,
    dept:           user.dept,
    effectiveDate:  effectiveDate,
    note:           note,
    createdAt:      new Date().toISOString(),
    createdBy:      SESSION.user?.id,
    status:         'completed',
  };
  DB.handoverRecords.push(handoverRecord);

  // 3. 해당 의사의 모든 환자에 대해 담당의 인수인계 처리
  //    → patientMaster에 currentDoctor 업데이트
  //    → 각 환자의 차트에 인수인계 Addendum 추가
  const myPatients = DB.patientMaster.filter(p =>
    p.visitHistory.some(v => v.doctor === uid)
  );

  let handoverAddendumCount = 0;
  myPatients.forEach(function(p) {
    // currentDoctor 업데이트
    p.currentDoctor = handoverToId;
    p.currentDoctorName = handoverName;

    // 해당 환자의 가장 최근 원본 차트에 인수인계 Addendum 추가
    const latestChart = DB.emrCharts
      .filter(c => c.ptId === p.pid && c.entryType === 'original')
      .sort(function(a,b){ return new Date(b.lockedAt) - new Date(a.lockedAt); })[0];

    if(latestChart) {
      const addendumId = 'ADM-HO-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
      const latestContent = getLatestContent(p.pid);
      DB.emrCharts.push({
        chartId: addendumId,
        entryType: 'addendum',
        originalChartId: latestChart.chartId,
        ptId: p.pid,
        status: 'locked',
        lockedAt: new Date().toISOString(),
        lockedBy: SESSION.user?.id || 'USR-001',
        doctor: SESSION.user?.name || '관리자',
        dept: user.dept,
        addendumCategory: 'handover',
        addendumReason: '[인수인계] ' + user.name + ' 원장 퇴사로 인해 ' + handoverName + '(으)로 담당의 변경. 퇴사일: ' + effectiveDate + (note ? '. 인수인계 메모: ' + note : ''),
        soap: latestContent ? latestContent.soap : {},
        vitals: latestContent ? latestContent.vitals : {},
        prescriptions: latestContent ? latestContent.prescriptions : [],
        isHandoverRecord: true,
        handoverRecordId: handoverRecord.id,
        fullSnapshot: {
          original: { chartId: latestChart.chartId, lockedAt: latestChart.lockedAt },
          prevAddendum: null,
        },
        hash: btoa('HO' + addendumId).substring(0,20),
      });
      handoverAddendumCount++;
    }
  });

  // 4. 감사 로그
  DB.auditLog.push({
    time: new Date().toISOString(),
    action: 'DOCTOR_RESIGNED_HANDOVER',
    user: SESSION.user?.username,
    name: SESSION.user?.name,
    fromDoctor: user.username,
    fromDoctorName: user.name,
    toDoctor: handoverTo?.username || 'TBD',
    toDoctorName: handoverName,
    patientCount: myPatients.length,
    addendumCount: handoverAddendumCount,
    handoverRecordId: handoverRecord.id,
    effectiveDate: effectiveDate,
    ip: '192.168.1.xxx',
  });

  document.getElementById('modal-resignation').classList.remove('open');
  pendingResignationUid = null;

  notify(
    '퇴사 처리 완료',
    user.name + ' → ' + handoverName + ' 인수인계 완료. 환자 ' + myPatients.length + '명, 차트 Addendum ' + handoverAddendumCount + '건 자동 생성.',
    'success'
  );
  renderScreen('users');
}

// 인수인계 현황 화면
function renderHandoverHistory(el) {
  const records = DB.handoverRecords || [];
  el.innerHTML =
    '<div class="section-title">🔄 의사 인수인계 이력</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">인수인계 기록</div></div>' +
      (records.length === 0
        ? '<div style="text-align:center;padding:24px;color:var(--text-muted)">인수인계 기록 없음</div>'
        : '<table><thead><tr><th>날짜</th><th>퇴사 의사</th><th>인수 의사</th><th>진료과</th><th>환자수</th><th>메모</th><th>관리</th></tr></thead><tbody>' +
          records.map(r =>
            '<tr>' +
            '<td style="font-family:var(--mono);font-size:11px">' + r.effectiveDate + '</td>' +
            '<td><strong>' + r.fromDoctorName + '</strong></td>' +
            '<td><strong style="color:var(--success)">' + r.toDoctorName + '</strong></td>' +
            '<td>' + ({ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과'}[r.dept]||r.dept) + '</td>' +
            '<td style="font-weight:700">' + (DB.patientMaster.filter(p=>p.currentDoctorName===r.toDoctorName).length||'-') + '명</td>' +
            '<td style="font-size:11px;color:var(--text-muted)">' + (r.note||'-') + '</td>' +
            '<td><button class="btn btn-sm btn-outline" onclick="notify(\'상세\',\'인수인계 상세 내역을 조회합니다.\',\'info\')">상세</button></td>' +
            '</tr>'
          ).join('') +
          '</tbody></table>'
      ) +
    '</div>';
}

function resetPassword(uid) {
  const user = DB.users.find(u => u.id === uid);
  if(!user) return;
  const tempPw = 'Temp' + Math.random().toString(36).substring(2,7) + '!1';
  user.password = tempPw;
  DB.auditLog.push({ time: new Date().toISOString(), action: 'PASSWORD_RESET', user: SESSION.user?.username, target: user.username, ip: '192.168.1.xxx' });
  notify('비밀번호 초기화', user.name + ' 임시 비밀번호: ' + tempPw + ' (문자로 발송)', 'warning');
}
function exportUsers() { notify('내보내기', '사용자 목록을 CSV로 내보냅니다.', 'info'); }


function renderPayment(el) {
  DB.currentScreen = 'payment';
  var pays     = DB.payments || [];
  var done     = pays.filter(function(p){return p.status==='완료';});
  var pending  = pays.filter(function(p){return p.status==='대기';});
  var unpaid   = pays.filter(function(p){return p.status==='미수';});
  var refunds  = pays.filter(function(p){return p.status==='환불';});
  var totalAmt = done.reduce(function(a,p){return a+(p.amount||0);},0);
  var unpaidAmt= unpaid.reduce(function(a,p){return a+(p.amount||0);},0);
  var refundAmt= refunds.reduce(function(a,p){return a+(p.amount||0);},0);

  function payRow(p) {
    var bdg = {완료:'badge-done', 대기:'badge-waiting', 미수:'badge-urgent', 환불:'badge-cancel'}[p.status]||'badge-waiting';
    return '<tr onclick="openPaymentDetail(\'" + p.id + "\')" style="cursor:pointer">' +
      '<td style="font-family:var(--mono);font-size:11px">' + (p.id||'-') + '</td>' +
      '<td><strong>' + (p.ptName||'-') + '</strong></td>' +
      '<td style="font-size:11px">' + (p.dept||'-') + '</td>' +
      '<td style="font-family:var(--mono)">' + (p.date||'-') + '</td>' +
      '<td style="font-weight:700">₩' + ((p.amount||0)/10000).toFixed(1) + 'M</td>' +
      '<td style="font-size:11px">' + (p.method||'-') + '</td>' +
      '<td><span class="badge ' + bdg + '">' + (p.status||'-') + '</span></td>' +
      '<td><div class="btn-group">' +
        (p.status==='대기'?'<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();processPayment(\'" + p.id + "\')">수납</button>':'') +
        '<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();printReceipt(\'" + p.id + "\')">영수증</button>' +
      '</div></td>' +
    '</tr>';
  }

  var listHtml = pays.length === 0
    ? '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">수납 데이터 없음 — 환자 접수 및 진료 완료 후 수납 처리하세요</td></tr>'
    : pays.slice().reverse().map(payRow).join('');

  var flowCols = [
    {col:'접수대기', color:'#ff9800', pts:DB.patients.filter(function(p){return p.status==='대기';})},
    {col:'진료중',   color:'#2196f3', pts:DB.patients.filter(function(p){return p.status==='진료중'||p.status==='치료중';})},
    {col:'처방대기', color:'#9c27b0', pts:DB.patients.filter(function(p){return p.status==='처방대기';})},
    {col:'수납대기', color:'#f44336', pts:DB.patients.filter(function(p){return p.status==='완료';}).slice(0,4)},
  ];

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
      '<div class="section-title" style="margin:0">💰 수납 관리</div>' +
      '<div class="btn-group">' +
        '<button class="btn btn-outline" onclick="generateDailyReport()">📊 일마감 출력</button>' +
        '<button class="btn btn-primary" onclick="openManualPayment()">+ 수납 등록</button>' +
      '</div>' +
    '</div>' +
    '<div class="grid-4" style="margin-bottom:16px">' +
      '<div class="stat-card blue"><div class="stat-label">오늘 수납 건수</div><div class="stat-value">' + done.length + '</div><div class="stat-sub">완료 ' + done.length + ' | 대기 ' + pending.length + '</div></div>' +
      '<div class="stat-card green"><div class="stat-label">오늘 총 수납액</div><div class="stat-value" style="font-size:20px">₩' + (totalAmt/10000).toFixed(1) + 'M</div></div>' +
      '<div class="stat-card orange"><div class="stat-label">미수금</div><div class="stat-value">' + unpaid.length + '건</div><div class="stat-sub">총 ' + Math.round(unpaidAmt/1000) + '천원</div></div>' +
      '<div class="stat-card red"><div class="stat-label">환불</div><div class="stat-value">' + refunds.length + '건</div><div class="stat-sub">' + Math.round(refundAmt/1000) + '천원</div></div>' +
    '</div>' +
    '<div class="card" style="margin-bottom:16px">' +
      '<div class="card-header"><div class="card-title">🔄 오늘 환자 흐름</div></div>' +
      '<div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:4px">' +
      flowCols.map(function(col){
        return '<div style="min-width:180px;flex:1">' +
          '<div style="font-size:11px;font-weight:700;color:' + col.color + ';margin-bottom:8px;padding-bottom:4px;border-bottom:2px solid ' + col.color + '">' + col.col + ' <span style="background:' + col.color + ';color:#fff;border-radius:10px;padding:1px 7px;font-size:10px">' + col.pts.length + '</span></div>' +
          col.pts.map(function(p){ return '<div style="padding:6px 8px;background:#fff;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:11px" onclick="openModal(\'modal-payment\')">' + p.name + '</div>'; }).join('') +
          (col.pts.length===0?'<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:11px">없음</div>':'') +
        '</div>';
      }).join('') +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><div class="card-title">📋 수납 내역</div>' +
        '<div class="btn-group">' +
          '<select class="form-control" style="width:auto" onchange="filterPayments(this.value)">' +
            '<option value="">전체</option><option value="완료">완료</option><option value="대기">대기</option><option value="미수">미수</option><option value="환불">환불</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="tbl-wrap"><table>' +
        '<thead><tr><th>수납번호</th><th>환자명</th><th>진료과</th><th>수납일</th><th>금액</th><th>결제수단</th><th>상태</th><th>관리</th></tr></thead>' +
        '<tbody id="payment-tbody">' + listHtml + '</tbody>' +
      '</table></div>' +
    '</div>';
}

function filterPayments(status) {
  var tbody = document.getElementById('payment-tbody');
  if(!tbody) return;
  var pays = status ? (DB.payments||[]).filter(function(p){return p.status===status;}) : (DB.payments||[]);
  if(pays.length===0) { tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--text-muted)">해당 수납 없음</td></tr>'; return; }
  tbody.innerHTML = pays.slice().reverse().map(function(p){
    var bdg = {완료:'badge-done',대기:'badge-waiting',미수:'badge-urgent',환불:'badge-cancel'}[p.status]||'badge-waiting';
    return '<tr><td style="font-family:var(--mono);font-size:11px">' + (p.id||'-') + '</td>' +
      '<td><strong>' + (p.ptName||'-') + '</strong></td>' +
      '<td style="font-size:11px">' + (p.dept||'-') + '</td>' +
      '<td style="font-family:var(--mono)">' + (p.date||'-') + '</td>' +
      '<td style="font-weight:700">₩' + ((p.amount||0)/10000).toFixed(1) + 'M</td>' +
      '<td style="font-size:11px">' + (p.method||'-') + '</td>' +
      '<td><span class="badge ' + bdg + '">' + (p.status||'-') + '</span></td>' +
      '<td><button class="btn btn-sm btn-ghost" onclick="printReceipt(\'" + p.id + "\'")>영수증</button></td></tr>';
  }).join('');
}

function openPaymentForPatient(pid) {
  var pt = DB.patients.find(function(x){return x.id===pid;}) ||
           DB.patientMaster.find(function(x){return x.pid===pid;});
  if(!pt) { notify('오류','환자를 찾을 수 없습니다.','error'); return; }
  currentPaymentPatient = pt;
  // 진료비 자동 계산 (급여 기준)
  var charts = DB.emrCharts.filter(function(c){return c.ptId===pid && c.entryType==='original';});
  var lastChart = charts.length>0 ? charts[charts.length-1] : null;
  var visitType = pt.type||'재진';
  // 건강보험 외래 진료비 기준 (심평원 수가 기준 추정)
  var baseFee = visitType==='신환'?15000:visitType==='초진'?12000:8000;
  var prescFee = (DB.prescriptions||[]).filter(function(p){return p.ptId===pid;}).length>0?3000:0;
  var totalCovered = baseFee + prescFee;
  var insurance = (pt.insurance||'건강보험');
  var copayRate = insurance==='건강보험'?0.3:insurance==='의료급여 1종'?0.1:insurance==='의료급여 2종'?0.15:1.0;
  var patientCovered = Math.round(totalCovered*copayRate/100)*100;
  currentPaymentData = {
    total: patientCovered,
    patientCovered: patientCovered,
    insuranceCovered: totalCovered - patientCovered,
    nonCoveredTotal: 0,
    baseFee, prescFee,
    visitType, insurance, copayRate,
  };
  renderPaymentModal();
  openModal('modal-payment');
}

function processPayment(id) {
  var p = (DB.payments||[]).find(function(x){return x.id===id;});
  if(!p) return;
  p.status='완료'; p.paidAt=new Date().toISOString();
  DB.auditLog.push({time:new Date().toISOString(),action:'PAYMENT_COMPLETED',user:SESSION.user?SESSION.user.username:'-',payId:id});
  notify('수납 완료', p.ptName + ' 수납 처리 완료 (₩' + Math.round((p.amount||0)/1000) + '천원)', 'success');
  renderScreen('payment');
}

function openPaymentDetail(id) {
  openModal('modal-payment');
}

function openManualPayment() {
  openModal('modal-payment');
}

function printReceipt(id) {
  notify('영수증', '영수증을 출력합니다.', 'info');
}


function renderPaymentModal() {
  const p = currentPaymentPatient;
  const f = currentPaymentData;
  if(!p || !f) return;
  const body = document.getElementById('payment-modal-body');
  if(!body) return;

  body.innerHTML = `
  <div class="grid-2" style="gap:16px">
    <!-- 왼쪽: 진료비 내역 -->
    <div>
      <div style="background:linear-gradient(135deg,var(--primary),var(--primary-light));border-radius:8px;padding:14px;margin-bottom:14px;color:#fff">
        <div style="font-size:10px;opacity:0.8;margin-bottom:4px;font-weight:600;letter-spacing:0.5px">환자 정보</div>
        <div style="font-size:17px;font-weight:800;margin-bottom:2px">${p.name} <span style="font-size:12px;font-weight:400;opacity:0.85">${p.gender} · ${calcAge(p.dob)}세</span></div>
        <div style="font-size:11px;opacity:0.8;font-family:var(--mono)">${p.id} | ${p.insurance} | ${p.type}</div>
        <div style="font-size:11px;opacity:0.8;margin-top:2px">${{ortho1:'정형외과1',ortho2:'정형외과2',neuro:'신경외과',internal:'내과',health:'건강검진',pt:'물리치료',nonsurg:'비수술'}[p.dept]||p.dept} | 접수: ${p.registered}</div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">📋 진료비 내역</div></div>
        ${f.itemLines.map(item => `
        <div class="fee-row">
          <span style="font-size:12px;color:${item.covered?'var(--text)':'var(--warning)'}">${item.label}</span>
          <span style="font-family:var(--mono);font-weight:600">${item.amt.toLocaleString()}원</span>
        </div>`).join('')}
        <div style="background:#f5f7fa;padding:8px 12px;border-radius:4px;margin:8px 0;font-size:11px">
          <div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:var(--text-muted)">급여 소계</span><span style="font-family:var(--mono)">${f.coveredTotal.toLocaleString()}원</span></div>
          ${f.nonCoveredTotal > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:var(--warning)">비급여 소계</span><span style="font-family:var(--mono);color:var(--warning)">${f.nonCoveredTotal.toLocaleString()}원</span></div>` : ''}
        </div>
        <div style="background:#e8f0fe;border-radius:6px;padding:10px 12px;margin-bottom:8px">
          <div class="fee-row" style="padding:3px 0;border:none"><span style="font-weight:600;color:var(--primary)">공단 부담금 (${Math.round((1-f.copayRate)*100)}%)</span><span style="font-family:var(--mono);color:var(--primary);font-weight:700">${f.nhisAmt.toLocaleString()}원</span></div>
          <div class="fee-row" style="padding:3px 0;border:none"><span style="font-weight:700;color:var(--danger)">본인부담금 (${Math.round(f.copayRate*100)}%)</span><span style="font-family:var(--mono);color:var(--danger);font-weight:800">${f.patientCovered.toLocaleString()}원</span></div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;background:var(--primary);color:#fff;padding:14px 16px;border-radius:6px">
          <span style="font-size:12px;font-weight:600;opacity:0.9">오늘 납부 총액</span>
          <span style="font-size:22px;font-weight:800;font-family:var(--mono)">${f.total.toLocaleString()}원</span>
        </div>
      </div>
    </div>

    <!-- 오른쪽: 결제 -->
    <div>
      <div class="card" style="margin-bottom:12px">
        <div class="card-header"><div class="card-title">💳 결제 방법</div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
          <button class="btn pay-method-btn" id="pm-cash" onclick="selectPayMethodDynamic('cash')"
            style="justify-content:center;padding:13px;flex-direction:column;gap:4px;border:2px solid var(--border)">
            <span style="font-size:22px">💵</span><span style="font-size:11px;font-weight:600">현금</span>
          </button>
          <button class="btn pay-method-btn btn-primary" id="pm-card" onclick="selectPayMethodDynamic('card')"
            style="justify-content:center;padding:13px;flex-direction:column;gap:4px;border:2px solid var(--primary)">
            <span style="font-size:22px">💳</span><span style="font-size:11px;font-weight:600">카드 리더기</span>
          </button>
          <button class="btn pay-method-btn" id="pm-simple" onclick="selectPayMethodDynamic('simple')"
            style="justify-content:center;padding:13px;flex-direction:column;gap:4px;border:2px solid var(--border)">
            <span style="font-size:22px">📱</span><span style="font-size:11px;font-weight:600">간편결제</span>
          </button>
          <button class="btn pay-method-btn" id="pm-later" onclick="selectPayMethodDynamic('later')"
            style="justify-content:center;padding:13px;flex-direction:column;gap:4px;border:2px solid var(--border)">
            <span style="font-size:22px">📋</span><span style="font-size:11px;font-weight:600">후불/미수금</span>
          </button>
        </div>

        <!-- 현금 입력 -->
        <div id="pay-field-cash" style="display:none">
          <div class="form-group" style="margin-bottom:8px">
            <label>받은 금액</label>
            <input class="form-control" id="cash-received" type="number" placeholder="${f.total}" oninput="calcChange(this.value,${f.total})" style="font-size:16px;font-weight:700;font-family:var(--mono)">
          </div>
          <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
            ${[10000,20000,50000,100000].map(v=>`<button class="btn btn-ghost btn-sm" onclick="document.getElementById('cash-received').value=${Math.ceil(f.total/v)*v};calcChange(${Math.ceil(f.total/v)*v},${f.total})">${(v/10000)}만</button>`).join('')}
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('cash-received').value=${f.total};calcChange(${f.total},${f.total})">딱맞게</button>
          </div>
          <div id="cash-change-display" style="background:#e8f5e9;border-radius:6px;padding:10px 14px;text-align:center;display:none">
            <span style="font-size:11px;color:var(--success)">거스름돈</span>
            <div id="cash-change-amount" style="font-size:22px;font-weight:800;color:var(--success);font-family:var(--mono)"></div>
          </div>
        </div>

        <!-- 카드 안내 -->
        <div id="pay-field-card" style="">
          <div style="background:#f0f4ff;border:1px solid #c5cae9;border-radius:6px;padding:12px;font-size:11px;line-height:1.8;margin-bottom:10px">
            <div style="font-weight:700;color:var(--primary);margin-bottom:4px">🖥 카드 리더기 연동</div>
            <div>• VAN사 연동: KICC, KSNET, KIS, NICE, SMARTRO 등</div>
            <div>• 연결 방식: RS232 / USB / 네트워크 (병원 설정에 따라 구성)</div>
            <div>• IC칩 삽입 / 마그네틱 스와이프 / NFC 비접촉 지원</div>
            <div>• 승인번호 자동 저장, 영수증 자동 출력</div>
          </div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;font-size:13px" onclick="openCardReaderModal(${f.total})">
            💳 카드 리더기 연결 & 결제 시작
          </button>
        </div>

        <!-- 간편결제 안내 -->
        <div id="pay-field-simple" style="display:none">
          <div style="background:#f0f4ff;border:1px solid #c5cae9;border-radius:6px;padding:12px;font-size:11px;line-height:1.8;margin-bottom:10px">
            <div style="font-weight:700;color:var(--primary);margin-bottom:4px">📱 간편결제 연동</div>
            <div>• 카카오페이 / 네이버페이 / 삼성페이 / 토스페이</div>
            <div>• QR코드 또는 바코드 스캔 방식</div>
            <div>• 결제 완료 시 자동 승인 처리</div>
          </div>
          <!-- QR 표시 영역 -->
          <div id="simple-qr-section" style="display:none;margin-top:16px">
            <div style="background:#f8fafd;border:1px solid var(--border);border-radius:10px;padding:20px;text-align:center">
              <div id="simple-qr-label" style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:12px">QR코드를 앱으로 스캔하세요</div>
              <div id="simple-qr-svg" style="display:inline-block;padding:8px;background:#fff;border:2px solid #000;border-radius:6px;margin-bottom:12px"></div>
              <div style="font-size:12px;color:var(--text)">유효시간: <span id="simple-timer" style="font-family:var(--mono);font-weight:800;color:var(--danger)">03:00</span></div>
              <div style="margin-top:10px">
                <div id="simple-status-msg" style="font-size:12px;color:var(--text-muted)">앱을 열고 QR코드를 스캔하세요</div>
                <div style="height:6px;background:#f0f2f5;border-radius:3px;overflow:hidden;margin-top:8px">
                  <div id="simple-progress" style="height:100%;background:var(--primary);width:0%;transition:width 0.5s;border-radius:3px"></div>
                </div>
              </div>
            </div>
          </div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;font-size:13px;margin-top:10px" onclick="startSimplePayQR(${f.total})">
            📱 간편결제 시작 (QR 표시)
          </button>
        </div>

        <!-- 후불 처리 -->
        <div id="pay-field-later" style="display:none">
          <div class="form-group" style="margin-bottom:8px">
            <label>미수금 사유</label>
            <select class="form-control">
              <option>신용불량 / 경제적 사정</option>
              <option>보험처리 대기</option>
              <option>법인/기관 청구 예정</option>
              <option>기타</option>
            </select>
          </div>
          <div class="form-group">
            <label>납부 예정일</label>
            <input class="form-control" type="date" value="${new Date(Date.now()+7*86400000).toISOString().substring(0,10)}">
          </div>
          <div style="background:#fff3e0;border-radius:6px;padding:10px;font-size:11px;color:var(--warning);margin-top:8px">
            ⚠ 미수금 등록 시 추후 납부 독촉 문자가 자동 발송됩니다.
          </div>
        </div>
      </div>

      <!-- 영수증 발행 -->
      <div class="card">
        <div class="card-header"><div class="card-title">🧾 영수증 발행</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${[
            {v:'print',icon:'🖨',label:'영수증 출력'},
            {v:'kakao',icon:'💬',label:'카카오톡'},
            {v:'sms',icon:'💬',label:'문자(SMS)'},
            {v:'email',icon:'📧',label:'이메일'},
            {v:'none',icon:'✕',label:'미발행'},
          ].map((r,i)=>`<label style="display:flex;align-items:center;gap:5px;padding:6px 10px;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;font-weight:500">
            <input type="radio" name="receipt" value="${r.v}" ${i===0?'checked':''}> ${r.icon} ${r.label}
          </label>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
  selectPayMethodDynamic('card');
}

function startSimplePayQR(amount) {
  const qrSection = document.getElementById('simple-qr-section');
  if (!qrSection) return;
  qrSection.style.display = 'block';

  // 기본 제공업체: 카카오페이
  const provider = SIMPLE_PAY_PROVIDERS.find(p => p.id === 'kakao');
  if (!provider) return;

  const label = document.getElementById('simple-qr-label');
  if (label) label.textContent = provider.name + ' 앱으로 QR코드를 스캔하세요';

  const qrSvg = document.getElementById('simple-qr-svg');
  if (qrSvg) qrSvg.innerHTML = buildQRSVG(provider.color);

  // 타이머
  let secs = 180;
  const timerEl = document.getElementById('simple-timer');
  const progressEl = document.getElementById('simple-progress');
  const statusEl = document.getElementById('simple-status-msg');

  if (window.simplePayTimer) clearInterval(window.simplePayTimer);
  window.simplePayTimer = setInterval(() => {
    secs--;
    if (timerEl) timerEl.textContent = String(Math.floor(secs/60)).padStart(2,'0') + ':' + String(secs%60).padStart(2,'0');
    if (progressEl) progressEl.style.width = ((180 - secs) / 180 * 100) + '%';
    if (secs <= 0) {
      clearInterval(window.simplePayTimer);
      if (statusEl) statusEl.textContent = '시간 초과되었습니다. 다시 시도하세요.';
    }
  }, 1000);

  // 결제 요청 (데모)
  const orderId = 'ORD-' + Date.now();
  if (statusEl) statusEl.textContent = '결제 요청 중...';
  setTimeout(() => {
    if (statusEl) statusEl.textContent = '앱을 열고 QR코드를 스캔하세요';
  }, 1000);

  // 실제 PG 연동 시 PaymentWebhookSimulator 대신 API 호출
}

function calcChange(received, total) {
  const r = parseInt(received) || 0;
  const display = document.getElementById('cash-change-display');
  const amtEl = document.getElementById('cash-change-amount');
  if(!display || !amtEl) return;
  if(r >= total) {
    display.style.display = 'block';
    amtEl.textContent = (r - total).toLocaleString() + '원';
    display.style.background = r === total ? '#e8f5e9' : '#e3f2fd';
    amtEl.style.color = r === total ? 'var(--success)' : 'var(--primary)';
  } else {
    display.style.display = 'none';
  }
}

function openCardReaderModal(amount) {
  selectedVAN = 'KICC';
  const body = document.getElementById('card-modal-body');
  if (!body) return;

  body.innerHTML =
    '<div style="background:#0d1b35;border-radius:10px;padding:16px;text-align:center;margin-bottom:16px">' +
      '<div style="color:#a8bcd8;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">결제 금액</div>' +
      '<div id="card-amount-display" style="color:#fff;font-size:30px;font-weight:900;font-family:var(--mono)">' + amount.toLocaleString() + '원</div>' +
      '<div id="card-installment-display" style="color:#90caf9;font-size:12px;margin-top:4px">일시불</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px">' +
      ['💳 IC 칩','↔ 마그네틱','📡 NFC'].map(function(s){
        return '<div style="flex:1;text-align:center;padding:10px 6px;background:#f8fafd;border:1px solid var(--border);border-radius:8px;font-size:11px;font-weight:600">' + s + '</div>';
      }).join('') +
    '</div>' +
    '<div style="margin-bottom:14px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--text-light);margin-bottom:8px">VAN사 선택</div>' +
      '<div id="van-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px"></div>' +
    '</div>' +
    '<div style="display:flex;gap:10px;margin-bottom:14px">' +
      '<div class="form-group" style="flex:1"><label>할부</label>' +
        '<select class="form-control" id="card-installment" onchange="updateInstallmentDisplay(this.value)">' +
          '<option value="0">일시불</option><option value="2">2개월</option><option value="3">3개월</option><option value="6">6개월</option><option value="12">12개월</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" style="flex:1"><label>영수증</label>' +
        '<select class="form-control" id="card-receipt-type"><option>영수증 출력</option><option>SMS 발송</option><option>미발행</option></select>' +
      '</div>' +
    '</div>' +
    '<div style="height:6px;background:#f0f2f5;border-radius:3px;overflow:hidden;margin-bottom:6px">' +
      '<div id="card-progress-bar" style="height:100%;background:var(--primary);width:0%;transition:width 0.4s;border-radius:3px"></div>' +
    '</div>' +
    '<div id="card-progress-msg" style="font-size:11px;color:var(--text-muted);text-align:center;min-height:18px">결제 준비 완료. 시작 버튼을 클릭하세요.</div>';

  var vanGrid = document.getElementById('van-grid');
  if (vanGrid) {
    VANLIST.forEach(function(v, i) {
      var btn = document.createElement('button');
      btn.textContent = v;
      btn.className = 'van-btn';
      btn.style.cssText = 'padding:7px 4px;border:2px solid ' + (i===0?'var(--primary)':'var(--border)') + ';border-radius:5px;background:' + (i===0?'#e8f0fe':'#fff') + ';color:' + (i===0?'var(--primary)':'#1a2332') + ';cursor:pointer;font-size:10px;font-weight:700;font-family:var(--font)';
      btn.onclick = function(){ selectVAN(btn, v); };
      vanGrid.appendChild(btn);
    });
  }

  var readBtn = document.getElementById('card-read-btn');
  if (readBtn) { readBtn.disabled = false; readBtn.textContent = '💳 결제 시작'; }

  closeModal('modal-payment');
  openModal('modal-card-reader');
}

function selectVAN(el, van) {
  document.querySelectorAll('.van-btn').forEach(function(b) {
    b.style.borderColor = 'var(--border)';
    b.style.background = '#fff';
    b.style.color = '#1a2332';
  });
  el.style.borderColor = 'var(--primary)';
  el.style.background = '#e8f0fe';
  el.style.color = 'var(--primary)';
  selectedVAN = van;
}

function updateInstallmentDisplay(val) {
  var el = document.getElementById('card-installment-display');
  if (el) el.textContent = val === '0' ? '일시불' : val + '개월 할부';
}

function simulateCardRead() {
  var btn = document.getElementById('card-read-btn');
  var progress = document.getElementById('card-progress-bar');
  var msg = document.getElementById('card-progress-msg');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 처리 중...';

  var steps = [
    {pct:15, msg: selectedVAN + ' VAN 서버 연결 중...', delay:0},
    {pct:35, msg:'카드 정보 판독 중 (IC 칩)...', delay:700},
    {pct:55, msg:'카드사 승인 요청 중...', delay:1600},
    {pct:80, msg:'결제 승인 처리 중...', delay:2500},
    {pct:100, msg:'✓ 승인 완료!', delay:3400},
  ];

  steps.forEach(function(s) {
    setTimeout(function() {
      if (!progress || !msg) return;
      progress.style.width = s.pct + '%';
      msg.textContent = s.msg;
      if (s.pct === 100) {
        progress.style.background = 'var(--success)';
        setTimeout(function() {
          closeModal('modal-card-reader');
          var installment = (document.getElementById('card-installment') || {}).value || '0';
          var approvalNum = 'AP' + Math.random().toString(36).slice(2,10).toUpperCase();
          notify('카드 결제 승인 완료', '승인번호: ' + approvalNum + '  |  VAN: ' + selectedVAN + '  |  ' + (installment==='0'?'일시불':installment+'개월'), 'success');
          finalizePayment('card', approvalNum);
        }, 600);
      }
    }, s.delay);
  });
}

function cancelCardReading() {
  closeModal('modal-card-reader');
  if (currentPaymentPatient) { openModal('modal-payment'); renderPaymentModal(); }
}

// ── 간편결제 ──────────────────────────────────────────
var SIMPLE_PAY_PROVIDERS = [
  {id:'kakao',   name:'카카오페이', color:'#FAE100', textColor:'#391B1B', bg:'#FFFDE7', letter:'K', desc:'카카오 앱 QR코드 스캔'},
  {id:'naver',   name:'네이버페이', color:'#03C75A', textColor:'#fff',    bg:'#E8F5E9', letter:'N', desc:'네이버 앱 QR코드 스캔'},
  {id:'samsung', name:'삼성페이',   color:'#1428A0', textColor:'#fff',    bg:'#E8EAF6', letter:'S', desc:'삼성 갤럭시 NFC 결제'},
  {id:'toss',    name:'토스페이',   color:'#0064FF', textColor:'#fff',    bg:'#E3F2FD', letter:'T', desc:'토스 앱 QR코드 스캔'},
  {id:'payco',   name:'PAYCO',      color:'#FF4440', textColor:'#fff',    bg:'#FFEBEE', letter:'P', desc:'PAYCO 앱 바코드'},
  {id:'lpay',    name:'L.PAY',      color:'#E60026', textColor:'#fff',    bg:'#FCE4EC', letter:'L', desc:'롯데포인트 통합결제'},
];

function openSimplePayModal(amount) {
  selectedSimplePayProvider = null;
  if (simplePayTimer) clearInterval(simplePayTimer);
  var body = document.getElementById('simple-pay-body');
  if (!body) return;

  var html = '<div style="background:linear-gradient(135deg,var(--primary),var(--primary-light));border-radius:10px;padding:14px;text-align:center;margin-bottom:16px;color:#fff">' +
    '<div style="font-size:10px;opacity:0.8;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">결제 금액</div>' +
    '<div id="simple-pay-amount" style="font-size:28px;font-weight:900;font-family:var(--mono)">' + amount.toLocaleString() + '원</div>' +
  '</div>' +
  '<div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:10px;letter-spacing:0.5px">결제 수단 선택</div>' +
  '<div id="sp-providers" style="display:flex;flex-direction:column;gap:8px">';

  SIMPLE_PAY_PROVIDERS.forEach(function(p) {
    html +=
      '<button id="sp-btn-' + p.id + '" onclick="selectSimplePay(\'' + p.id + '\')" ' +
        'style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:2px solid var(--border);border-radius:10px;background:#fff;cursor:pointer;width:100%;text-align:left;font-family:var(--font);transition:all 0.2s">' +
        '<div style="width:40px;height:40px;border-radius:10px;background:' + p.color + ';display:flex;align-items:center;justify-content:center;color:' + p.textColor + ';font-size:18px;font-weight:900;flex-shrink:0">' + p.letter + '</div>' +
        '<div style="flex:1">' +
          '<div style="font-size:13px;font-weight:700;color:#1a2332">' + p.name + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);margin-top:1px">' + p.desc + '</div>' +
        '</div>' +
        '<div id="sp-check-' + p.id + '" style="display:none;width:22px;height:22px;border-radius:50%;background:var(--success);color:#fff;font-size:12px;font-weight:700;align-items:center;justify-content:center;flex-shrink:0">✓</div>' +
      '</button>';
  });

  html += '</div>' +
  '<div id="sp-qr-wrap" style="display:none;margin-top:16px">' +
    '<div style="background:#f8fafd;border:1px solid var(--border);border-radius:10px;padding:20px;text-align:center">' +
      '<div id="sp-qr-label" style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:12px">QR코드를 앱으로 스캔하세요</div>' +
      '<div id="sp-qr-svg" style="display:inline-block;padding:8px;background:#fff;border:2px solid #000;border-radius:6px;margin-bottom:12px"></div>' +
      '<div style="font-size:12px;color:var(--text)">유효시간: <span id="sp-timer" style="font-family:var(--mono);font-weight:800;color:var(--danger)">03:00</span></div>' +
      '<div style="margin-top:10px">' +
        '<div id="sp-status-msg" style="font-size:12px;color:var(--text-muted)">앱을 열고 QR코드를 스캔하세요</div>' +
        '<div style="height:6px;background:#f0f2f5;border-radius:3px;overflow:hidden;margin-top:8px">' +
          '<div id="sp-progress" style="height:100%;background:var(--primary);width:0%;transition:width 0.5s;border-radius:3px"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';

  body.innerHTML = html;

  var reqBtn = document.getElementById('sp-request-btn');
  if (reqBtn) { reqBtn.textContent = 'QR 결제 요청'; reqBtn.onclick = requestSimplePayQR; }

  closeModal('modal-payment');
  openModal('modal-simple-pay');
}

function selectSimplePay(id) {
  selectedSimplePayProvider = id;
  SIMPLE_PAY_PROVIDERS.forEach(function(p) {
    var btn = document.getElementById('sp-btn-' + p.id);
    var chk = document.getElementById('sp-check-' + p.id);
    if (!btn) return;
    if (p.id === id) {
      btn.style.borderColor = p.color;
      btn.style.background = p.bg;
      btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
      if (chk) chk.style.display = 'flex';
    } else {
      btn.style.borderColor = 'var(--border)';
      btn.style.background = '#fff';
      btn.style.boxShadow = 'none';
      if (chk) chk.style.display = 'none';
    }
  });
}

function requestSimplePayQR() {
  if (!selectedSimplePayProvider) { notify('선택 오류', '결제 수단을 선택하세요.', 'error'); return; }
  var provider = SIMPLE_PAY_PROVIDERS.filter(function(p){ return p.id === selectedSimplePayProvider; })[0];
  if (!provider) return;

  var label = document.getElementById('sp-qr-label');
  if (label) label.textContent = provider.name + ' 앱으로 QR코드를 스캔하세요';

  var qrWrap = document.getElementById('sp-qr-svg');
  if (qrWrap) qrWrap.innerHTML = buildQRSVG(provider.color);

  var qrSection = document.getElementById('sp-qr-wrap');
  if (qrSection) qrSection.style.display = 'block';

  var reqBtn = document.getElementById('sp-request-btn');
  if (reqBtn) { reqBtn.textContent = '결제 취소'; reqBtn.onclick = closeSimplePay; }

  // ── 실제 PG 연동 구조 ──
  // 실제 운영 환경:
  // 1. 병원 서버가 PG사 API로 결제 주문 생성 (orderId, amount, providerId)
  // 2. PG사가 QR/바코드 URL 반환 → 화면에 표시
  // 3. 환자가 앱으로 스캔 후 결제 승인
  // 4. PG사가 병원 서버 Webhook URL로 POST 전송 (결제 결과)
  //    예: POST https://192.168.1.10:8443/api/v1/payment/webhook
  //        { orderId, status:'APPROVED', approvalNum, amount, paidAt }
  // 5. 병원 서버가 EMR DB 업데이트 → 프론트엔드에 SSE/WebSocket으로 실시간 푸시
  //
  // 데모 환경: PaymentWebhookSimulator로 대체

  var orderId = 'ORD-' + Date.now();
  PaymentWebhookSimulator.startListening(orderId, provider, function(result) {
    onPaymentWebhookReceived(result);
  });

  // 타이머
  var secs = 180;
  simplePayTimer = setInterval(function() {
    secs--;
    var m = String(Math.floor(secs/60)).padStart(2,'0');
    var s = String(secs%60).padStart(2,'0');
    var el = document.getElementById('sp-timer');
    if (el) el.textContent = m + ':' + s;
    if (secs <= 0) {
      clearInterval(simplePayTimer);
      PaymentWebhookSimulator.stop();
      notify('시간 초과', 'QR코드가 만료되었습니다.', 'warning');
      closeSimplePay();
    }
  }, 1000);
}

// ════════════════════════════════════════════════════════
// 결제 Webhook 시뮬레이터
// 실제 운영: PG사 서버 → 병원 서버 → SSE/WebSocket → 프론트엔드
// 데모: 실제와 동일한 응답 구조로 시뮬레이션
// ════════════════════════════════════════════════════════
var PaymentWebhookSimulator = {
  _timer: null,
  _pollTimer: null,
  _orderId: null,
  _provider: null,
  _cb: null,

  startListening: function(orderId, provider, callback) {
    this._orderId = orderId;
    this._provider = provider;
    this._cb = callback;
    this.stop();

    // 실제: EventSource('/api/v1/payment/sse/' + orderId) 또는 WebSocket
    // 데모: 진행 상태를 단계별로 표시하다가 실제 응답 구조로 완료

    var self = this;
    var steps = [
      { delay: 1200, status: 'PENDING',     msg: 'QR 스캔 대기 중...', pct: 20 },
      { delay: 2500, status: 'SCANNED',     msg: provider.name + ' 앱 스캔 감지됨', pct: 45 },
      { delay: 3800, status: 'AUTHENTICATING', msg: '사용자 인증 진행 중 (지문/비밀번호)...', pct: 65 },
      { delay: 5000, status: 'PROCESSING',  msg: 'PG사 결제 승인 요청 중...', pct: 82 },
      { delay: 6200, status: 'APPROVED',    msg: '✓ 결제 승인 완료', pct: 100 },
    ];

    steps.forEach(function(step) {
      var t = setTimeout(function() {
        // UI 업데이트
        var prog = document.getElementById('sp-progress');
        var msgEl = document.getElementById('sp-status-msg');
        if (prog) prog.style.width = step.pct + '%';
        if (msgEl) msgEl.textContent = step.msg;

        if (step.status === 'APPROVED') {
          if (prog) prog.style.background = 'var(--success)';
          clearInterval(simplePayTimer);

          // 실제 PG사 Webhook 응답 구조 (예: 카카오페이 응답 형식)
          var webhookPayload = {
            orderId: self._orderId,
            status: 'APPROVED',
            approvalNum: provider.letter + Math.random().toString(36).slice(2,10).toUpperCase(),
            provider: provider.id,
            providerName: provider.name,
            amount: currentPaymentData ? currentPaymentData.total : 0,
            paidAt: new Date().toISOString(),
            cardInfo: null,
            receiptUrl: 'https://receipt.' + provider.id + '.example/r/' + self._orderId,
            // 카카오페이 전용
            tid: provider.id === 'kakao' ? ('T' + Date.now()) : null,
            // 토스페이 전용
            paymentKey: provider.id === 'toss' ? ('toss_' + Date.now()) : null,
          };

          setTimeout(function() {
            self._cb(webhookPayload);
          }, 600);
        }
      }, step.delay);
      if (!self._timers) self._timers = [];
      self._timers.push(t);
    });
  },

  stop: function() {
    if (this._timers) {
      this._timers.forEach(clearTimeout);
      this._timers = [];
    }
  }
};

// ── VAN사 카드 승인 응답 구조 ──────────────────────────
var CardVANSimulator = {
  processApproval: function(vanName, amount, installment, callback) {
    // 실제: VAN 드라이버(DLL/SDK) → 리더기 → 카드사 → 승인 응답
    // 응답 구조 (KICC/KSNET 등 공통 형식)
    var steps = [
      { pct: 15, msg: vanName + ' 서버 연결 중...', delay: 0 },
      { pct: 35, msg: '카드 정보 판독 (IC 칩 EMV)...', delay: 750 },
      { pct: 58, msg: '카드사 실시간 승인 요청 중...', delay: 1700 },
      { pct: 82, msg: '승인 처리 중 (전문 전송)...', delay: 2600 },
      { pct: 100, msg: '✓ 승인 완료', delay: 3500 },
    ];

    steps.forEach(function(s) {
      setTimeout(function() {
        var prog = document.getElementById('card-progress-bar');
        var msg  = document.getElementById('card-progress-msg');
        if (prog) prog.style.width = s.pct + '%';
        if (msg)  msg.textContent = s.msg;
        if (s.pct === 100) {
          if (prog) prog.style.background = 'var(--success)';
          // VAN사 승인 응답 구조
          var vanResponse = {
            resultCode: '0000',       // 0000 = 승인
            resultMsg: '승인완료',
            approvalNum: 'AP' + Math.random().toString(36).slice(2,10).toUpperCase(),
            approvalDate: new Date().toISOString().slice(0,10).replace(/-/g,''),
            approvalTime: new Date().toTimeString().slice(0,8).replace(/:/g,''),
            cardNum: '****-****-****-' + String(Math.floor(Math.random()*9000)+1000),
            cardName: ['삼성카드','KB국민카드','신한카드','현대카드','롯데카드'][Math.floor(Math.random()*5)],
            installment: installment,
            amount: amount,
            vanCode: vanName,
            vanTid: vanName + Date.now(),
          };
          setTimeout(function() { callback(vanResponse); }, 500);
        }
      }, s.delay);
    });
  }
};

// ── Webhook 수신 처리 ────────────────────────────────────
function onPaymentWebhookReceived(result) {
  closeModal('modal-simple-pay');
  // 완료 모달 표시
  showPaymentComplete({
    method: result.providerName || '간편결제',
    approvalNum: result.approvalNum,
    amount: result.amount,
    paidAt: result.paidAt,
    receiptUrl: result.receiptUrl,
    extraInfo: result.tid ? 'TID: ' + result.tid : (result.paymentKey ? 'KEY: ' + result.paymentKey : ''),
    provider: result.provider,
  });
}

function onCardVANApproved(vanResp) {
  closeModal('modal-card-reader');
  showPaymentComplete({
    method: vanResp.cardName + ' (' + vanResp.vanCode + ')',
    approvalNum: vanResp.approvalNum,
    cardNum: vanResp.cardNum,
    amount: vanResp.amount,
    installment: vanResp.installment,
    paidAt: new Date().toISOString(),
    receiptUrl: null,
    provider: 'card',
  });
}

// ── 결제 완료 화면 ────────────────────────────────────────
function showPaymentComplete(info) {
  var p = currentPaymentPatient;
  var f = currentPaymentData;
  if (!p || !f) return;

  var installText = (!info.installment || info.installment === '0') ? '일시불' : info.installment + '개월 할부';
  var paidTime = info.paidAt ? new Date(info.paidAt).toLocaleString('ko-KR') : new Date().toLocaleString('ko-KR');

  // DB.payments에 저장
  if(!DB.payments) DB.payments = [];
  var existPay = DB.payments.find(function(x){ return x.ptId===p.id && x.status==='대기'; });
  if(existPay) {
    existPay.status = '완료';
    existPay.paidAt = new Date().toISOString();
    existPay.method = (info&&info.method)||'기타';
    existPay.approvalNum = (info&&info.approvalNum)||'';
  } else {
    var dept = (DB.patients.find(function(x){return x.id===p.id;})||{}).dept||'';
    DB.payments.push({
      id:'PAY-'+Date.now(), ptId:p.id, ptName:p.name,
      dept:dept, amount:(f&&f.total)||0,
      method:(info&&info.method)||'기타',
      approvalNum:(info&&info.approvalNum)||'',
      insuranceType:(p.insurance||'건강보험'),
      status:'완료', paidAt:new Date().toISOString(),
      issuedAt:new Date().toISOString(),
    });
  }
  // 환자 상태 업데이트
  var pt = DB.patients.find(function(x){ return x.id === p.id; });
  if (pt) { pt.paymentStatus = 'paid'; pt.status = '완료'; }
  DB.auditLog.push({
    time: new Date().toISOString(), action: 'PAYMENT_COMPLETED',
    user: SESSION.user ? SESSION.user.username : '-',
    patientId: p.id, amount: f.total,
    method: info.method, approvalNum: info.approvalNum
  });

  // 영수증 발행 처리 (실제: 병원 서버 → SMS/알림톡 API 호출)
  var receiptMode = (document.querySelector('input[name="receipt"]:checked') || {}).value || 'print';
  sendReceipt(p, f, info, receiptMode);

  // 완료 모달 렌더링
  var overlay = document.getElementById('modal-payment-complete');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-payment-complete';
    overlay.className = 'modal-overlay open';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('open');

  overlay.innerHTML =
    '<div class="modal" style="max-width:480px">' +
      '<div class="modal-header" style="background:linear-gradient(135deg,#1b5e20,#2e7d32);border:none">' +
        '<div class="modal-title" style="color:#fff;font-size:15px">✓ 수납 완료</div>' +
        '<button class="modal-close" style="color:rgba(255,255,255,0.7)" onclick="closePaymentComplete()">✕</button>' +
      '</div>' +
      '<div class="modal-body" style="padding:0">' +

        // 영수증 헤더
        '<div style="background:#f0fdf4;border-bottom:1px solid #c8e6c9;padding:20px 24px;text-align:center">' +
          '<div style="width:56px;height:56px;border-radius:50%;background:#2e7d32;display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px;margin:0 auto 10px">✓</div>' +
          '<div style="font-size:18px;font-weight:800;color:#1b5e20;margin-bottom:4px">결제가 완료되었습니다</div>' +
          '<div style="font-size:28px;font-weight:900;color:#1a2332;font-family:var(--mono);margin:8px 0">' + f.total.toLocaleString() + '원</div>' +
          '<div style="font-size:11px;color:var(--text-muted)">' + paidTime + '</div>' +
        '</div>' +

        // 결제 상세
        '<div style="padding:16px 24px">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">결제 정보</div>' +
          [
            ['환자명', p.name + ' (' + p.id + ')'],
            ['결제 수단', info.method],
            ['승인번호', info.approvalNum],
            info.cardNum ? ['카드번호', info.cardNum] : null,
            info.installment && info.installment !== '0' ? ['할부', installText] : null,
            info.extraInfo ? ['참조번호', info.extraInfo] : null,
          ].filter(Boolean).map(function(row) {
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f2f5;font-size:12px">' +
              '<span style="color:var(--text-muted)">' + row[0] + '</span>' +
              '<span style="font-weight:700;font-family:' + (row[0]==='승인번호'||row[0]==='카드번호'||row[0]==='참조번호'?'var(--mono)':'inherit') + '">' + row[1] + '</span>' +
            '</div>';
          }).join('') +

          // 진료비 요약
          '<div style="background:#f8fafd;border-radius:8px;padding:12px;margin-top:12px">' +
            '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">' +
              '<span style="color:var(--text-muted)">급여 본인부담</span><span style="font-family:var(--mono)">' + f.patientCovered.toLocaleString() + '원</span>' +
            '</div>' +
            (f.nonCoveredTotal > 0 ?
              '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">' +
                '<span style="color:var(--text-muted)">비급여</span><span style="font-family:var(--mono)">' + f.nonCoveredTotal.toLocaleString() + '원</span>' +
              '</div>' : '') +
            '<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:800;border-top:1px solid var(--border);padding-top:6px;margin-top:2px">' +
              '<span>납부 합계</span><span style="color:var(--primary);font-family:var(--mono)">' + f.total.toLocaleString() + '원</span>' +
            '</div>' +
          '</div>' +

          // 영수증 발송 상태
          '<div id="receipt-send-status" style="margin-top:12px;padding:10px 14px;background:#e3f2fd;border:1px solid #bbdefb;border-radius:6px;font-size:12px;color:#1565c0"></div>' +

        '</div>' +
      '</div>' +

      '<div class="modal-footer" style="gap:8px;justify-content:center">' +
        '<button class="btn btn-ghost" onclick="printReceiptNow()">🖨 영수증 출력</button>' +
        '<button class="btn btn-outline" onclick="sendReceiptSMS(\'' + p.id + '\')">📱 문자 재발송</button>' +
        '<button class="btn btn-primary" style="min-width:120px" onclick="closePaymentComplete()">확인</button>' +
      '</div>' +
    '</div>';

  // 영수증 발송 상태 표시
  renderReceiptStatus(receiptMode, p, info);

  currentPaymentPatient = null;
  currentPaymentData = null;
}

// ── 영수증 / 문자 발송 ────────────────────────────────────
// 실제 구현:
// SMS → 병원 서버 POST /api/v1/sms/send { to, message, template:'RECEIPT' }
//   → NHN Cloud/솔라피/KT문자 API 호출 → 환자 휴대폰으로 발송
// 카카오 알림톡 → POST /api/v1/kakao/alimtalk { to, templateCode:'RECEIPT', params }
//   → 카카오 비즈니스 API → 카카오톡으로 영수증 전송
function sendReceipt(patient, feeData, payInfo, mode) {
  // 실제 서버 API 호출 (데모에서는 로컬 처리)
  var msg = '[정동병원] ' + patient.name + '님 진료비 수납 완료\n' +
    '납부금액: ' + feeData.total.toLocaleString() + '원\n' +
    '승인번호: ' + payInfo.approvalNum + '\n' +
    '문의: 02-1234-5678';

  // API 호출 구조 (실제 운영 시)
  API.post('/sms/send', {
    to: patient.phone,
    message: msg,
    templateCode: 'RECEIPT_' + mode.toUpperCase(),
    patientId: patient.id,
    amount: feeData.total,
    approvalNum: payInfo.approvalNum,
  });
  // 카카오 알림톡 (건강보험 환자 대상)
  if (patient.insurance === '건강보험') {
    API.post('/kakao/alimtalk', {
      to: patient.phone,
      templateCode: 'HOSPITAL_RECEIPT_01',
      params: {
        '#{name}': patient.name,
        '#{amount}': feeData.total.toLocaleString(),
        '#{date}': new Date().toLocaleDateString('ko-KR'),
        '#{approvalNum}': payInfo.approvalNum,
      }
    });
  }
}

function renderReceiptStatus(mode, patient, payInfo) {
  var el = document.getElementById('receipt-send-status');
  if (!el) return;
  var phone = patient.phone || '미등록';
  var maskedPhone = phone.replace(/(\d{3})-(\d{3,4})-(\d{4})/, function(m,a,b,c){ return a+'-'+b.replace(/\d/g,'*')+'-'+c; });

  if (mode === 'print') {
    el.style.background = '#e8f5e9'; el.style.borderColor = '#c8e6c9'; el.style.color = '#2e7d32';
    el.innerHTML = '🖨 영수증 프린터로 출력 중...';
    setTimeout(function(){ if(el) el.innerHTML = '✓ 영수증 출력 완료'; }, 1200);
  } else if (mode === 'kakao') {
    el.innerHTML = '💬 카카오 알림톡 발송 중... (' + maskedPhone + ')';
    setTimeout(function(){
      if (el) { el.style.background = '#e8f5e9'; el.style.borderColor = '#c8e6c9'; el.style.color = '#2e7d32';
        el.innerHTML = '✓ 카카오 알림톡 발송 완료 → ' + maskedPhone + '<br><small>영수증 알림톡을 확인해주세요</small>'; }
    }, 1800);
  } else if (mode === 'sms') {
    el.innerHTML = '📱 SMS 발송 중... (' + maskedPhone + ')';
    setTimeout(function(){
      if (el) { el.style.background = '#e8f5e9'; el.style.borderColor = '#c8e6c9'; el.style.color = '#2e7d32';
        el.innerHTML = '✓ SMS 발송 완료 → ' + maskedPhone; }
    }, 1500);
  } else if (mode === 'email') {
    el.innerHTML = '📧 이메일 발송 중...';
    setTimeout(function(){
      if (el) { el.style.background = '#e8f5e9'; el.style.borderColor = '#c8e6c9'; el.style.color = '#2e7d32';
        el.innerHTML = '✓ 이메일 발송 완료'; }
    }, 2000);
  } else {
    el.style.display = 'none';
  }
}

function sendReceiptSMS(pid) {
  var p = DB.patientMaster.find(function(x){ return x.pid === pid; }) ||
          DB.patients.find(function(x){ return x.id === pid; });
  if (!p) return;
  var phone = (p.phone || p.phone || '');
  var masked = phone.replace(/(\d{3})-(\d{3,4})-(\d{4})/, function(m,a,b,c){ return a+'-'+b.replace(/\d/g,'*')+'-'+c; });
  notify('SMS 재발송', (p.name || '') + ' (' + masked + ') 로 영수증 문자를 발송했습니다.', 'info');
}

function printReceiptNow() {
  notify('영수증 출력', '영수증을 출력합니다.', 'info');
}

function closePaymentComplete() {
  var el = document.getElementById('modal-payment-complete');
  if (el) { el.classList.remove('open'); setTimeout(function(){ el.remove(); }, 300); }
  renderScreen(DB.currentScreen || 'payment');
}

// ── simulateCardRead 업데이트 (VAN 응답 구조 사용) ─────────
function simulateCardRead() {
  var btn = document.getElementById('card-read-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 처리 중...';
  var amount = currentPaymentData ? currentPaymentData.total : 0;
  var installment = (document.getElementById('card-installment') || {}).value || '0';
  CardVANSimulator.processApproval(selectedVAN, amount, installment, onCardVANApproved);
}

// ── finalizePayment (하위 호환 유지) ───────────────────────
function finalizePayment(method, approvalNum) {
  // 이미 showPaymentComplete 에서 처리됨. 직접 호출되는 경우(현금)만 처리
  if (!currentPaymentPatient) return;
  var p = currentPaymentPatient;
  var f = currentPaymentData;
  showPaymentComplete({
    method: method === 'cash' ? '현금' : method,
    approvalNum: approvalNum,
    amount: f ? f.total : 0,
    paidAt: new Date().toISOString(),
    provider: method,
  });
}

function processPayment() {
  var cashField = document.getElementById('pay-field-cash');
  if (cashField && cashField.style.display !== 'none') {
    var received = parseInt((document.getElementById('cash-received') || {}).value) || 0;
    if (currentPaymentData && received < currentPaymentData.total) {
      notify('금액 오류', '받은 금액이 부족합니다.', 'error'); return;
    }
    closeModal('modal-payment');
    // 현금 영수증 처리
    var receiptMode = (document.querySelector('input[name="receipt"]:checked') || {}).value || 'print';
    if (currentPaymentPatient && currentPaymentData) {
      sendReceipt(currentPaymentPatient, currentPaymentData, { approvalNum: 'CASH-' + Date.now(), method: '현금' }, receiptMode);
    }
    finalizePayment('cash', 'CASH-' + Date.now());
    return;
  }
  notify('안내', '카드 또는 간편결제 버튼을 클릭하여 결제를 시작하세요.', 'info');
}

function printPaymentReceipt() {
  notify('출력', '진료비 납부확인서를 출력합니다.', 'info');
}

function printPrescriptionForPatient() {
  if (!currentPaymentPatient) {
    notify('오류', '환자 정보가 없습니다.', 'error');
    return;
  }
  
  // 환자의 최신 처방 찾기
  var prescriptions = DB.prescriptions || [];
  var patientPrx = prescriptions.filter(function(p) {
    return p.ptId === currentPaymentPatient.id && p.status !== 'cancelled';
  }).sort(function(a, b) {
    return new Date(b.issuedAt) - new Date(a.issuedAt);
  });
  
  if (patientPrx.length === 0) {
    notify('안내', '해당 환자의 처방 기록이 없습니다.', 'info');
    return;
  }
  
  // 최신 처방으로 모달 채우기
  var latestPrx = patientPrx[0];
  fillPrescriptionModal(latestPrx);
  openModal('modal-prescription');
  
  notify('처방전 출력', currentPaymentPatient.name + '의 처방전을 준비했습니다.', 'success');
}

function fillPrescriptionModal(prx) {
  if (!prx) return;
  
  // 모달 요소 채우기
  document.getElementById('prx-doctor-name').textContent = prx.doctor || '-';
  document.getElementById('prx-pt-name').textContent = prx.ptName || '-';
  document.getElementById('prx-pt-dob').textContent = prx.ptDob ? prx.ptDob.substring(0,10) : '-';
  document.getElementById('prx-date').textContent = prx.issuedAt ? prx.issuedAt.substring(0,10) : '-';
  
  // 약품 테이블 채우기 (간단히)
  var tbody = document.querySelector('#prescription-print-area tbody');
  if (tbody && prx.drugs) {
    tbody.innerHTML = prx.drugs.map(function(drug) {
      return '<tr>' +
        '<td style="border:1px solid #ccc;padding:5px 8px">' + (drug.name || '') + '</td>' +
        '<td style="border:1px solid #ccc;padding:5px 8px;text-align:center">' + (drug.dosage || '') + '</td>' +
        '<td style="border:1px solid #ccc;padding:5px 8px;text-align:center">' + (drug.frequency || '') + '</td>' +
        '<td style="border:1px solid #ccc;padding:5px 8px;text-align:center">' + (drug.days || '') + '</td>' +
        '<td style="border:1px solid #ccc;padding:5px 8px">' + (drug.instruction || '') + '</td>' +
      '</tr>';
    }).join('');
  }
}

function buildQRSVG(accentColor) {
  var cells = '';
  var size = 21, cellSize = 8, pad = 4;
  var total = size * cellSize + pad * 2;
  var seed = Date.now() % 9999;
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      var inFinder = (r < 8 && c < 8) || (r < 8 && c >= size-8) || (r >= size-8 && c < 8);
      if (inFinder) continue;
      if (r === 6 || c === 6) {
        if ((r + c) % 2 === 0) cells += '<rect x="' + (pad+c*cellSize) + '" y="' + (pad+r*cellSize) + '" width="' + (cellSize-1) + '" height="' + (cellSize-1) + '" fill="black" rx="1"/>';
        continue;
      }
      if ((r * size + c + seed) % 3 === 0) {
        cells += '<rect x="' + (pad+c*cellSize) + '" y="' + (pad+r*cellSize) + '" width="' + (cellSize-1) + '" height="' + (cellSize-1) + '" fill="black" rx="1"/>';
      }
    }
  }
  [[0,0],[0,size-7],[size-7,0]].forEach(function(fp){
    var x = pad + fp[1]*cellSize, y = pad + fp[0]*cellSize;
    cells += '<rect x="'+x+'" y="'+y+'" width="'+(7*cellSize)+'" height="'+(7*cellSize)+'" fill="black" rx="2"/>';
    cells += '<rect x="'+(x+cellSize)+'" y="'+(y+cellSize)+'" width="'+(5*cellSize)+'" height="'+(5*cellSize)+'" fill="white" rx="1"/>';
    cells += '<rect x="'+(x+2*cellSize)+'" y="'+(y+2*cellSize)+'" width="'+(3*cellSize)+'" height="'+(3*cellSize)+'" fill="'+accentColor+'" rx="1"/>';
  });
  return '<svg width="'+total+'" height="'+total+'" viewBox="0 0 '+total+' '+total+'" xmlns="http://www.w3.org/2000/svg"><rect width="'+total+'" height="'+total+'" fill="white" rx="4"/>'+cells+'</svg>';
}

function openNursingRecord(bed) { openModal('modal-nursing'); switchNursingTab('vitals', null); }
function saveNursing() { closeModal('modal-nursing'); notify('저장', '간호기록이 DB에 저장되었습니다.', 'success'); }

// ─── ADMISSION (입원 등록) ───────────────────────────────
function openAdmit() { openAdmitToBed(''); }

function getWardRoomOccupancy(bedNum) {
  var roomId = bedNum + '호';
  return (DB.wardPatients||[]).filter(function(w){return w.bed===roomId;}).length;
}

function openAdmitToBed(preselectedBed) {
  // 빈 병상 목록 동적 생성
  var WINGS = [
    {id:'5', beds:['501','502','503','504','505','506','507','508','509','510']},
    {id:'6', beds:['601','602','603','604','605','606','607','608','609','610']},
    {id:'7', beds:['701','702','703','704','705','706','707','708','709','710']},
  ];
  var bedSel = document.getElementById('admit-bed');
  if(bedSel) {
    bedSel.innerHTML = '<option value="">-- 비어있는 병상 선택 --</option>';
    WINGS.forEach(function(wing) {
      var grp = document.createElement('optgroup');
      grp.label = wing.id + '병동';
      wing.beds.forEach(function(b) {
        var cap = getWardRoomCapacity(b);
        if(cap <= 0) return; // 미사용 호실 제외

        var current = getWardRoomOccupancy(b);
        var bed = b + '호';

        var opt = document.createElement('option');
        opt.value = bed;
        opt.textContent = bed + ' (' + current + '/' + cap + '명)';

        if(current >= cap) {
          opt.disabled = true; // 만실
          opt.textContent += ' - 만실';
        }

        if(preselectedBed && b === preselectedBed) opt.selected = true;
        grp.appendChild(opt);
      });
      if(grp.children.length > 0) bedSel.appendChild(grp);
    });

    // 선택지 중에 활성화된 값이 없으면 안내 메세지
    var available = Array.from(bedSel.options).some(function(o){return o.value && !o.disabled;});
    if(!available) {
      bedSel.innerHTML = '<option value="">빈 병상 없음 (전 병상 사용중 또는 미사용 호실 제외)</option>';
    }
  }

  // 담당의 목록 — DB.users에서 의사만 동적 로드
  var docSel = document.getElementById('admit-doctor');
  if(docSel) {
    docSel.innerHTML = '<option value="">-- 담당의 선택 --</option>';
    var doctors = DB.users.filter(function(u) {
      return u.status === 'active' && (
        u.role === 'hospital_director' ||
        u.role.startsWith('doctor_')
      );
    });
    var deptLabel = {
      ortho1:'정형외과1', ortho2:'정형외과2', neuro:'신경외과',
      internal:'내과·건강검진', anesthesia:'마취통증의학과',
      radiology:'진단영상의학과', health:'건강검진'
    };
    doctors.forEach(function(u) {
      var opt = document.createElement('option');
      opt.value = u.name;
      opt.textContent = u.name + ' (' + (deptLabel[u.dept]||u.dept) + ')';
      docSel.appendChild(opt);
    });
    if(doctors.length === 0) {
      docSel.innerHTML = '<option value="">등록된 의사 없음 — 계정 관리에서 등록하세요</option>';
    }
  }

  // 환자 검색창 초기화
  var ptSearch = document.getElementById('admit-pt-search');
  var ptResult = document.getElementById('admit-pt-result');
  if(ptSearch) ptSearch.value = '';
  if(ptResult) ptResult.innerHTML = '';

  openModal('modal-admit');
}

function registerAdmission() {
  var bedEl    = document.getElementById('admit-bed');
  var diagEl   = document.getElementById('admit-diagnosis');
  var doctorEl = document.getElementById('admit-doctor');
  var ptEl     = document.getElementById('admit-pt-search');

  if(!bedEl || !bedEl.value) { notify('오류','병상을 선택하세요.','error'); return; }
  if(!doctorEl || !doctorEl.value) { notify('오류','담당의를 선택하세요.','error'); return; }

  var ptName = ptEl ? ptEl.value.split('(')[0].trim() : '';
  if(!ptName) { notify('오류','환자명을 입력하세요.','error'); return; }

  // 이미 입원 중인 병상인지 재확인
  var alreadyOccupied = (DB.wardPatients||[]).some(function(w){return w.bed===bedEl.value;});
  if(alreadyOccupied) { notify('오류',bedEl.value+'는 이미 사용 중인 병상입니다.','error'); return; }

  // 환자 정보 연결
  var ptRec = DB.patientMaster.find(function(p){return p.name===ptName;}) ||
              DB.patients.find(function(p){return p.name===ptName;});

  var newWard = {
    bed:       bedEl.value,
    name:      ptName,
    ptId:      ptRec ? (ptRec.pid||ptRec.id) : null,
    age:       ptRec ? (calcAge ? calcAge(ptRec.dob) : (ptRec.age||'')) : '',
    gender:    ptRec ? (ptRec.gender||'-') : '-',
    diagnosis: diagEl ? diagEl.value : '입원',
    admitDate: new Date().toISOString().substring(0,10),
    doctor:    doctorEl.value,
    diet:      document.getElementById('admit-diet-breakfast')?document.getElementById('admit-diet-breakfast').value:'normal',
    status:    '입원',
    vitals:    {},
    isolation: false,
    dietBreakfast: (document.getElementById('admit-diet-breakfast')||{}).value||'normal',
    dietLunch:     (document.getElementById('admit-diet-lunch')||{}).value||'normal',
    dietDinner:    (document.getElementById('admit-diet-dinner')||{}).value||'normal',
    companionMeal: parseInt((document.getElementById('admit-companion-meal')||{}).value||'0'),
    guardian: {
      name:  (document.getElementById('admit-guardian-name')||{}).value||'',
      rel:   (document.getElementById('admit-guardian-rel')||{}).value||'',
      phone: (document.getElementById('admit-guardian-phone')||{}).value||'',
    },
  };

  DB.wardPatients.push(newWard);
  DB.auditLog.push({
    time:new Date().toISOString(), action:'ADMISSION',
    user:SESSION.user?SESSION.user.username:'-',
    bed:newWard.bed, patient:ptName, doctor:newWard.doctor
  });

  closeModal('modal-admit');
  notify('입원 등록 완료', newWard.bed + ' ' + ptName + ' 입원 등록이 완료되었습니다.', 'success');
  renderScreen('ward');
}


// ─── PRESCRIPTION PRINT ─────────────────────────────────
function printChart() {
  openModal('modal-prescription');
}

function showWardPatient(bed) {
  const wp = DB.wardPatients.find(w => w.bed === bed);
  if(!wp) { notify('병상정보', bed + ' 상세 정보를 조회합니다.', 'info'); return; }
  openModal('modal-nursing');
  switchNursingTab('vitals', null);
}
function toggleMAR(cell) {
  const span = cell.querySelector('span');
  const states = ['○','✓','✗'];
  const cur = span.textContent.trim();
  const next = states[(states.indexOf(cur)+1)%3];
  span.textContent = next;
  span.style.color = next==='✓'?'var(--success)':next==='✗'?'var(--danger)':'#ccc';
}

// ─── RESERVATION HELPERS ────────────────────────────────
function addReservation(dateStr) {
  var today = new Date().toISOString().substring(0,10);
  // 과거 날짜 클릭 → 차단
  if(dateStr && dateStr < today) {
    notify('예약 불가', '오늘 이전 날짜에는 예약할 수 없습니다.', 'error');
    return;
  }
  openReservationModal(dateStr || today);
}

async function loadReservations(dateStr) {
  try {
    var res = await API.get(API.endpoints.reservations, {date: dateStr});
    if(res && res.success && Array.isArray(res.data)) {
      DB.reservations = res.data;
      DB.reservationsLoaded = true;
    }
  } catch (err) {
    console.error('예약 로드 실패', err);
  }
}

async function createReservation(resv) {
  var res = await API.post(API.endpoints.reservations, resv);
  if(res && res.success) {
    if(!DB.reservations) DB.reservations = [];
    var existingIndex = (DB.reservations||[]).findIndex(function(r){return r.id===resv.id;});
    if(existingIndex === -1) { DB.reservations.push(resv); }
    return true;
  }
  return false;
}

async function cancelReservationBackend(id) {
  var res = await API.delete(API.endpoints.reservations, {id: id});
  if(res && res.success) {
    if(DB.reservations) {
      var record = DB.reservations.find(function(r){return r.id===id;});
      if(record) record.status='취소';
    }
    return true;
  }
  return false;
}

// ─── DAILY REPORT (일마감 출력) ──────────────────────────
function generateDailyReport() {
  const today = new Date().toISOString().substring(0, 10);
  const pays = DB.payments || [];
  const todayPays = pays.filter(p => p.date === today && p.status === '완료');
  const totalRevenue = todayPays.reduce((sum, p) => sum + (p.amount || 0), 0);
  const cashPays = todayPays.filter(p => p.method === '현금');
  const cardPays = todayPays.filter(p => p.method === '카드');
  const simplePays = todayPays.filter(p => p.method === '간편결제');

  const patients = DB.patients || [];
  const todayVisits = patients.filter(p => p.registered && p.registered.startsWith(today));
  const completedVisits = todayVisits.filter(p => p.status === '완료');

  const prescriptions = DB.prescriptions || [];
  const todayRx = prescriptions.filter(rx => rx.date === today);

  // 보고서 HTML 생성
  const reportHtml = `
    <div style="font-family: var(--font); max-width: 600px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 20px;">
        <h2 style="color: var(--primary); margin: 0;">🏥 정동병원 일마감 보고서</h2>
        <p style="color: var(--text-muted); margin: 5px 0;">${today} (기준: 결제 완료 시점)</p>
      </div>

      <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
        <h3 style="margin: 0 0 10px 0; color: var(--primary);">💰 수납 현황</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
          <div style="text-align: center;">
            <div style="font-size: 18px; font-weight: bold;">${todayPays.length}건</div>
            <div style="font-size: 12px; color: var(--text-muted);">총 수납</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 18px; font-weight: bold;">₩${(totalRevenue / 10000).toFixed(1)}M</div>
            <div style="font-size: 12px; color: var(--text-muted);">총 금액</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 18px; font-weight: bold;">${completedVisits.length}명</div>
            <div style="font-size: 12px; color: var(--text-muted);">진료 완료</div>
          </div>
        </div>
        <div style="margin-top: 10px; font-size: 12px;">
          <div>현금: ${cashPays.length}건 (₩${cashPays.reduce((s, p) => s + p.amount, 0).toLocaleString()})</div>
          <div>카드: ${cardPays.length}건 (₩${cardPays.reduce((s, p) => s + p.amount, 0).toLocaleString()})</div>
          <div>간편결제: ${simplePays.length}건 (₩${simplePays.reduce((s, p) => s + p.amount, 0).toLocaleString()})</div>
        </div>
      </div>

      <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
        <h3 style="margin: 0 0 10px 0; color: var(--primary);">👥 진료 현황</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div style="text-align: center;">
            <div style="font-size: 18px; font-weight: bold;">${todayVisits.length}명</div>
            <div style="font-size: 12px; color: var(--text-muted);">총 접수</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 18px; font-weight: bold;">${todayRx.length}건</div>
            <div style="font-size: 12px; color: var(--text-muted);">처방 발행</div>
          </div>
        </div>
      </div>

      <div style="background: #fff3cd; padding: 15px; border-radius: 8px; border-left: 4px solid #ffc107;">
        <h4 style="margin: 0 0 10px 0; color: #856404;">📋 보고 상태</h4>
        <div style="font-size: 12px; color: #856404;">
          <div>• 심평원 청구: 준비 완료 (자동 전송 예정)</div>
          <div>• 세무서 보고: 준비 완료 (월말 일괄 전송)</div>
          <div>• 감사 로그: ${DB.auditLog.filter(l => l.time.startsWith(today)).length}건 기록됨</div>
        </div>
      </div>

      <div style="text-align: center; margin-top: 20px; font-size: 11px; color: var(--text-muted);">
        정동병원 EMR 시스템 © 2026 | 출력일시: ${new Date().toLocaleString('ko-KR')}
      </div>
    </div>
  `;

  // 모달에 표시
  const modalBody = document.getElementById('daily-report-body');
  if (modalBody) {
    modalBody.innerHTML = reportHtml;
    openModal('modal-daily-report');
  } else {
    // 모달이 없으면 새로 생성
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'modal-daily-report';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 700px;">
        <div class="modal-header">
          <div class="modal-title">📊 일마감 보고서</div>
          <button class="modal-close" onclick="closeModal('modal-daily-report')">×</button>
        </div>
        <div class="modal-body" id="daily-report-body">${reportHtml}</div>
        <div class="modal-footer">
          <button class="btn btn-primary" onclick="printDailyReport()">🖨 인쇄</button>
          <button class="btn btn-outline" onclick="exportDailyReport()">📤 내보내기</button>
          <button class="btn btn-ghost" onclick="closeModal('modal-daily-report')">닫기</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    openModal('modal-daily-report');
  }

  notify('일마감 보고서', '오늘의 일마감 보고서를 생성했습니다.', 'success');
}

function printDailyReport() {
  const reportContent = document.getElementById('daily-report-body').innerHTML;
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>정동병원 일마감 보고서</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h2, h3, h4 { color: #333; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
          .center { text-align: center; }
        </style>
      </head>
      <body>${reportContent}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.print();
}

function exportDailyReport() {
  const reportContent = document.getElementById('daily-report-body').innerText;
  const blob = new Blob([reportContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `일마감보고서_${new Date().toISOString().substring(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  notify('내보내기 완료', '보고서가 텍스트 파일로 저장되었습니다.', 'success');
}

function openReservationModal(dateStr) {
  var date = dateStr || new Date(Date.now()+86400000).toISOString().substring(0,10);
  var overlay = document.getElementById('modal-reservation-add');
  if(!overlay) { notify('오류','예약 모달을 찾을 수 없습니다.','error'); return; }

  // 날짜 입력 업데이트
  var dateEl = document.getElementById('resv-date');
  if(dateEl) dateEl.value = date;

  // 시간 슬롯 렌더링
  refreshResvTimeSlots(date, '');
  // 과거 날짜 선택 불가
  var dateEl2 = document.getElementById('resv-date');
  if(dateEl2) dateEl2.min = new Date().toISOString().substring(0,10);
  openModal('modal-reservation-add');
}

function refreshResvTimeSlots(dateStr, dept) {
  var container = document.getElementById('resv-time-slots');
  if(!container) return;

  if(!dateStr) { container.innerHTML = '<div style="color:var(--text-muted);font-size:11px">날짜를 먼저 선택하세요</div>'; return; }

  var date = new Date(dateStr);
  var dow  = date.getDay();
  var month = date.getMonth()+1, day = date.getDate(), year = date.getFullYear();

  // 휴무일 체크
  if(dow===0 || isKoreanHoliday(year, month, day)) {
    container.innerHTML = '<div style="background:#ffebee;border-radius:6px;padding:10px;color:#c62828;font-size:12px">🔴 ' + (dow===0?'일요일':'공휴일') + ' — 진료 없음</div>';
    return;
  }

  var slots = getAvailableSlots(dateStr, dept);
  if(slots.length===0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:11px">진료 가능 시간이 없습니다</div>';
    return;
  }

  // 오늘 날짜인지 확인하고, 이미 지난 시간 비활성화
  var today = new Date().toISOString().substring(0,10);
  var now = new Date();
  var isToday = dateStr === today;

  slots.forEach(function(s) {
    if(isToday) {
      var slotTime = new Date(dateStr + 'T' + s.time + ':00');
      s.past = slotTime < now;
    } else {
      s.past = false;
    }
  });

  var html = '<div style="display:flex;flex-wrap:wrap;gap:5px">';
  var selectedTime = document.getElementById('resv-time') ? document.getElementById('resv-time').value : '';
  slots.forEach(function(s) {
    var isSelected = s.time === selectedTime;
    var isDisabled = s.full || s.past;
    var bg = isDisabled ? '#e0e0e0' : isSelected ? 'var(--primary)' : '#f0f7ff';
    var fg = isDisabled ? '#9e9e9e' : isSelected ? '#fff' : '#1565c0';
    var cursor = isDisabled ? 'not-allowed' : 'pointer';
    var onclick = isDisabled ? '' : 'selectResvTime(\'' + s.time + '\')';
    var title = s.full ? '예약 마감' : s.past ? '지난 시간' : '';
    html += '<div onclick="' + onclick + '" style="padding:5px 10px;border-radius:5px;font-size:12px;font-family:var(--mono);font-weight:600;background:'+bg+';color:'+fg+';cursor:'+cursor+';border:1.5px solid '+(isSelected?'var(--primary)':isDisabled?'#bdbdbd':'#90caf9')+';user-select:none" ' + (title?'title="'+title+'"':'') + '>' +
      s.time + (s.taken>0 && !s.full ? '<span style="font-size:9px;margin-left:2px">('+s.taken+')</span>' : '') +
      (s.full ? '<br><span style="font-size:9px">마감</span>' : s.past ? '<br><span style="font-size:9px">지남</span>' : '') +
    '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

function selectResvTime(time) {
  // 이미 지난 시간 선택 방지
  var dateVal = document.getElementById('resv-date') ? document.getElementById('resv-date').value : '';
  var today = new Date().toISOString().substring(0,10);
  if(dateVal === today) {
    var now = new Date();
    var slotTime = new Date(dateVal + 'T' + time + ':00');
    if(slotTime < now) {
      notify('선택 불가', '지난 시간은 선택할 수 없습니다.', 'warning');
      return;
    }
  }

  var timeEl = document.getElementById('resv-time');
  if(timeEl) timeEl.value = time;
  // 날짜와 진료과 읽어서 슬롯 다시 렌더링
  var deptVal = document.getElementById('resv-dept') ? document.getElementById('resv-dept').value : '';
  refreshResvTimeSlots(dateVal, deptVal);
}

function saveReservation() {
  var date  = (document.getElementById('resv-date')||{}).value;
  var time  = (document.getElementById('resv-time')||{}).value;
  var dept  = (document.getElementById('resv-dept')||{}).value;
  if(!date || !time || !dept) { notify('오류','날짜, 시간, 진료과는 필수입니다.','error'); return; }

  // 마감 여부 재확인
  var slots = getAvailableSlots(date, dept);
  var slot = slots.find(function(s){return s.time===time;});
  if(!slot) { notify('오류','선택한 시간은 진료 시간이 아닙니다.','error'); return; }
  if(slot.full) { notify('예약 불가','해당 시간은 이미 마감되었습니다. 다른 시간을 선택해주세요.','error'); return; }

  var ptSearch = (document.getElementById('resv-pt-search')||{}).value || '';
  var resv = {
    id:'RSV-'+Date.now(), date:date, time:time, dept:dept,
    patient: ptSearch,
    doctor: (document.getElementById('resv-doctor')||{}).value||'-',
    type:   (document.getElementById('resv-type')||{}).value||'재진',
    phone:  (document.getElementById('resv-phone')||{}).value||'-',
    memo:   (document.getElementById('resv-memo')||{}).value||'',
    status:'확정', source:'staff',
    createdAt: new Date().toISOString(),
    createdBy: SESSION.user ? SESSION.user.id : 'staff',
  };
  if(!DB.reservations) DB.reservations = [];
  DB.reservations.push(resv);
  DB.auditLog.push({time:new Date().toISOString(),action:'RESERVATION_CREATED',user:SESSION.user?SESSION.user.username:'-',resvId:resv.id,date:date,time:time});
  closeModal('modal-reservation-add');
  notify('예약 등록',''+date+' '+time+' 예약이 등록되었습니다.','success');
  renderScreen('reservation');
}


function searchResvPatient() {
  const q = document.getElementById('resv-pt-search')?.value || '';
  const result = document.getElementById('resv-pt-result');
  if(!result || !q) return;
  const found = DB.patients.filter(p => p.name.includes(q) || p.id.includes(q)).slice(0,3);
  if(found.length === 0) { result.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">검색 결과 없음</div>'; return; }
  result.innerHTML = found.map(p => `
    <div onclick="fillResvPatient('${p.id}')" style="padding:7px 10px;background:#f8fafd;border:1px solid var(--border);border-radius:4px;margin-top:4px;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:10px">
      <strong>${p.name}</strong><span style="color:var(--text-muted)">${p.gender}·${calcAge(p.dob)}세</span>
      <span style="font-family:var(--mono);font-size:10px;color:var(--primary)">${p.id}</span>
      <span style="font-size:11px">${p.phone}</span>
    </div>`).join('');
}

function fillResvPatient(pid) {
  const p = DB.patients.find(x => x.id === pid);
  if(!p) return;
  const search = document.getElementById('resv-pt-search');
  const phone = document.getElementById('resv-phone');
  const result = document.getElementById('resv-pt-result');
  if(search) search.value = p.name + ' (' + p.id + ')';
  if(phone) phone.value = p.phone;
  if(result) result.innerHTML = '<div style="font-size:11px;color:var(--success);margin-top:4px">✓ ' + p.name + ' 선택됨</div>';
}

async function saveReservation() {
  const date = document.getElementById('resv-date')?.value;
  const time = document.getElementById('resv-time')?.value;
  const dept = document.getElementById('resv-dept')?.value;
  if(!date || !time || !dept) { notify('오류', '날짜, 시간, 진료과는 필수입니다.', 'error'); return; }

  // 이미 지난 시간 예약 불가
  var now = new Date();
  var target = new Date(date + 'T' + time + ':00');
  if(target < now) {
    notify('예약 불가', '지나간 시간으로 예약할 수 없습니다.', 'error');
    return;
  }

  // 마감 여부 재확인
  var slots = getAvailableSlots(date, dept);
  var slot = slots.find(function(s){return s.time===time;});
  if(!slot) { notify('오류', '선택한 시간은 진료 시간이 아닙니다.', 'error'); return; }
  if(slot.full) { notify('예약 불가', '해당 시간은 이미 마감되었습니다. 다른 시간을 선택해주세요.', 'error'); return; }

  const ptSearch = document.getElementById('resv-pt-search')?.value || '';
  const resv = {
    id: 'RSV-' + Date.now(),
    date, time, dept,
    patient: ptSearch,
    doctor: document.getElementById('resv-doctor')?.value || '-',
    type: document.getElementById('resv-type')?.value || '재진',
    phone: document.getElementById('resv-phone')?.value || '-',
    memo: document.getElementById('resv-memo')?.value || '',
    status: '확정',
    source: 'staff',
    createdAt: new Date().toISOString(),
    createdBy: SESSION.user ? SESSION.user.id : 'staff'
  };

  const ok = await createReservation(resv);
  if(!ok) { notify('예약 실패', '서버에 예약을 저장하지 못했습니다.', 'error'); return; }

  closeModal('modal-reservation-add');
  notify('예약 등록 완료', date + ' ' + time + ' 예약이 등록되었습니다.', 'success');
  renderScreen('reservation');
}

// ─── MODALS ────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('open');
  // 접수 모달 열릴 때 현재 로그인 의사의 진료과/담당의 자동 선택
  if(id === 'modal-reception' && SESSION.user) {
    var role = SESSION.user.role;
    var isDoc = role.startsWith('doctor_') || role === 'hospital_director';
    if(isDoc) {
      setTimeout(function(){
        var deptSel = document.getElementById('pt-dept');
        var docSel  = document.getElementById('pt-doctor');
        if(deptSel && SESSION.user.dept) {
          Array.from(deptSel.options).forEach(function(o){
            o.selected = (o.value === SESSION.user.dept);
          });
          // 담당의 목록 업데이트
          updateDoctorList(SESSION.user.dept);
          // 본인 자동 선택
          setTimeout(function(){
            if(docSel) {
              Array.from(docSel.options).forEach(function(o){
                o.selected = (o.value === SESSION.user.name || o.text.startsWith(SESSION.user.name));
              });
            }
          }, 30);
        }
      }, 10);
    }
  }
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if(e.target === m) m.classList.remove('open'); });
});

// ─── NOTIFICATIONS ─────────────────────────────────────
function notify(title, msg, type='info') {
  const icons = {success:'✅',error:'🚫',warning:'⚠',info:'ℹ'};
  const cont = document.getElementById('notif-container');
  const el = document.createElement('div');
  el.className = `notif-item ${type}`;
  el.innerHTML = `<span style="font-size:18px">${icons[type]||'ℹ'}</span>
  <div class="notif-text"><div class="notif-title">${title}</div><div class="notif-sub">${msg}</div></div>
  <button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px;padding:0 4px;align-self:flex-start">✕</button>`;
  cont.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── CLOCK ─────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const d = now.toLocaleDateString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit'});
  const t = now.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const el = document.getElementById('clock');
  if(el) el.textContent = `${d} ${t}`;
}
setInterval(updateClock, 1000);
updateClock();

// ─── INIT SCREENS ──────────────────────────────────────
Object.keys(screens).forEach(name => {
  const el = document.getElementById('screen-' + name);
  if(!el) return;
});

