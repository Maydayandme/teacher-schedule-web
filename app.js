// Keep null for normal use. A temporary URL such as ?date=2026-08-24
// can be used during development without adding a date picker to the page.
const TEST_DATE = null;
const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const dateSummary = document.querySelector("#date-summary");
const status = document.querySelector("#status");
const lessonList = document.querySelector("#lesson-list");
const weekControls = document.querySelector("#week-controls");
const weekLabel = document.querySelector("#week-label");
const previousWeek = document.querySelector("#previous-week");
const nextWeek = document.querySelector("#next-week");
const currentWeek = document.querySelector("#current-week");
const viewTabs = document.querySelectorAll(".view-tab");
const scheduleFile = document.querySelector("#schedule-file");
const restoreSchedule = document.querySelector("#restore-schedule");
const importStatus = document.querySelector("#import-status");
const installApp = document.querySelector("#install-app");
let deferredInstallPrompt = null;

let schedule = null;
let viewMode = "today";
let selectedWeekIndex = 0;
let localEdits = {};

const LOCAL_STORAGE_KEY = "teacher_schedule_local_edits";
const IMPORTED_SCHEDULE_KEY = "teacher_schedule_imported_schedule";

const REQUIRED_SCHEDULE_FIELDS = [
  "schema_version", "semester_id", "semester_name", "semester_start_date",
  "semester_end_date", "time_zone", "teacher_name", "week_ranges", "lessons"
];
const REQUIRED_LESSON_FIELDS = [
  "lesson_id", "date", "week_number", "weekday", "start_time", "end_time",
  "period_text", "course_name", "class_name", "lesson_type", "teaching_content_default"
];

function parseLocalDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function setImportStatus(message, type = "") {
  importStatus.textContent = message;
  importStatus.className = `import-status${type ? ` ${type}` : ""}`;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installApp.hidden = false;
  installApp.disabled = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installApp.hidden = true;
  installApp.disabled = false;
  setImportStatus("教师课表已安装到手机", "success");
});

installApp.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    setImportStatus("请使用 Chrome 打开本页面后再点击安装到手机。");
    return;
  }

  installApp.disabled = true;
  try {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (choice.outcome === "accepted") {
      installApp.hidden = true;
      setImportStatus("教师课表已安装到手机", "success");
    }
  } catch (error) {
    deferredInstallPrompt = null;
    setImportStatus("请使用 Chrome 打开本页面后再点击安装到手机。");
    console.warn("PWA 安装提示失败", error);
  } finally {
    if (!installApp.hidden) {
      installApp.disabled = false;
    }
  }
});

function validateSchedule(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("课表文件格式不正确，未导入。");
  }
  const missingTopLevel = REQUIRED_SCHEDULE_FIELDS.filter((field) => !hasOwn(candidate, field));
  if (missingTopLevel.length || candidate.schema_version !== "1.0" || !Array.isArray(candidate.week_ranges) || !Array.isArray(candidate.lessons)) {
    throw new Error("课表文件格式不正确，未导入。");
  }
  candidate.lessons.forEach((lesson, index) => {
    const missingLesson = REQUIRED_LESSON_FIELDS.filter((field) => !hasOwn(lesson, field));
    if (missingLesson.length) {
      throw new Error(`课表文件格式不正确，未导入：第 ${index + 1} 条课程缺少关键字段。`);
    }
  });
  return candidate;
}

function readImportedSchedule() {
  try {
    const saved = localStorage.getItem(IMPORTED_SCHEDULE_KEY);
    if (!saved) return null;
    return validateSchedule(JSON.parse(saved));
  } catch (error) {
    localStorage.removeItem(IMPORTED_SCHEDULE_KEY);
    console.warn("本地导入课表无效，已回退网站默认课表", error);
    return null;
  }
}

function renderAfterScheduleChange() {
  const currentWeek = getWeekIndexForDate(getSelectedDate());
  selectedWeekIndex = currentWeek >= 0 ? currentWeek : 0;
  renderCurrentView();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function loadLocalEdits() {
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    localEdits = saved ? JSON.parse(saved) : {};
    if (!localEdits || typeof localEdits !== "object" || Array.isArray(localEdits)) localEdits = {};
  } catch (error) {
    localEdits = {};
    console.warn("本地课表修改读取失败，已使用空状态", error);
  }
}

function getLessonState(lesson) {
  const semesterEdits = localEdits[schedule.semester_id];
  const state = semesterEdits && semesterEdits[lesson.lesson_id];
  return state && typeof state === "object" ? state : {};
}

function persistLessonState(lesson, changes) {
  const semesterId = schedule.semester_id;
  if (!localEdits[semesterId]) localEdits[semesterId] = {};
  const semesterEdits = localEdits[semesterId];
  const current = semesterEdits[lesson.lesson_id] || {};

  Object.entries(changes).forEach(([key, value]) => {
    if (value === undefined) delete current[key];
    else current[key] = value;
  });

  if (Object.keys(current).length) {
    current.updated_at = new Date().toISOString();
    semesterEdits[lesson.lesson_id] = current;
  } else {
    delete semesterEdits[lesson.lesson_id];
  }
  if (!Object.keys(semesterEdits).length) delete localEdits[semesterId];
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(localEdits));
}

function getEffectiveContent(lesson, state) {
  return hasOwn(state, "teaching_content_override")
    ? state.teaching_content_override
    : lesson.teaching_content_default;
}

function emptyText(value, fallback) {
  return value ? escapeHtml(value) : `<span class="muted-text">${fallback}</span>`;
}

function renderEditableDetails(lesson, compact) {
  const state = getLessonState(lesson);
  const content = getEffectiveContent(lesson, state);
  const hasOverride = hasOwn(state, "teaching_content_override");
  const note = hasOwn(state, "personal_note") ? state.personal_note : "";
  const contentHeading = compact ? "教学内容" : "今日教学内容";
  const contentId = `content-editor-${lesson.lesson_id}`;
  const noteId = `note-editor-${lesson.lesson_id}`;

  return `
    <section class="editable-section">
      <div class="section-heading"><strong>${contentHeading}</strong>${hasOverride ? '<span class="edited-badge">已修改</span>' : ""}</div>
      <div class="content-display">${emptyText(content, "（内容为空）")}</div>
      <div class="action-row">
        <button class="small-button" type="button" data-action="edit-content" data-lesson-id="${lesson.lesson_id}" data-editor-id="${contentId}">修改教学内容</button>
        ${hasOverride ? `<button class="small-button secondary-button" type="button" data-action="restore-content" data-lesson-id="${lesson.lesson_id}">恢复默认内容</button>` : ""}
      </div>
      <div id="${contentId}" class="editor-panel" hidden>
        <textarea class="editor-textarea" data-editor-field="content" aria-label="教学内容编辑">${escapeHtml(content)}</textarea>
        <div class="action-row">
          <button class="small-button" type="button" data-action="save-content" data-lesson-id="${lesson.lesson_id}">保存</button>
          <button class="small-button secondary-button" type="button" data-action="cancel-editor" data-editor-id="${contentId}">取消</button>
        </div>
      </div>
    </section>
    <section class="editable-section note-section">
      <div class="section-heading"><strong>个人备注</strong></div>
      <div class="note-display">${emptyText(note, "暂无个人备注")}</div>
      <div class="action-row">
        <button class="small-button secondary-button" type="button" data-action="edit-note" data-lesson-id="${lesson.lesson_id}" data-editor-id="${noteId}">编辑备注</button>
      </div>
      <div id="${noteId}" class="editor-panel" hidden>
        <textarea class="editor-textarea" data-editor-field="note" aria-label="个人备注编辑">${escapeHtml(note)}</textarea>
        <div class="action-row">
          <button class="small-button" type="button" data-action="save-note" data-lesson-id="${lesson.lesson_id}">保存</button>
          <button class="small-button secondary-button" type="button" data-action="cancel-editor" data-editor-id="${noteId}">取消</button>
        </div>
      </div>
    </section>`;
}

function renderLesson(lesson, compact = false) {
  const time = lesson.start_time && lesson.end_time ? `${lesson.start_time}–${lesson.end_time}` : "时间待补";
  const type = lesson.lesson_type === "experiment" ? "实验" : "理论";
  if (compact) {
    const detailsId = `details-${lesson.lesson_id}`;
    return `
      <article class="lesson-card week-lesson-card">
        <button class="lesson-toggle" type="button" aria-expanded="false" aria-controls="${detailsId}">
          <p class="lesson-time">${escapeHtml(time)} · ${escapeHtml(lesson.period_text)}</p>
          <h3 class="lesson-title">${escapeHtml(lesson.course_name)}</h3>
          <dl class="lesson-meta">
            <div><dt>班级</dt><dd>${escapeHtml(lesson.class_name)}</dd></div>
            <div><dt>教室</dt><dd>${escapeHtml(lesson.classroom || "未填写")}</dd></div>
            <div><dt>类型</dt><dd>${type}</dd></div>
          </dl>
        </button>
        <div id="${detailsId}" class="week-details" hidden>${renderEditableDetails(lesson, true)}</div>
      </article>`;
  }

  return `
    <article class="lesson-card">
      <p class="lesson-time">${escapeHtml(time)} · ${escapeHtml(lesson.period_text)}</p>
      <h2 class="lesson-title">${escapeHtml(lesson.course_name)}</h2>
      <dl class="lesson-meta">
        <div><dt>班级</dt><dd>${escapeHtml(lesson.class_name)}</dd></div>
        <div><dt>专业</dt><dd>${escapeHtml(lesson.major)}</dd></div>
        <div><dt>教室</dt><dd>${escapeHtml(lesson.classroom || "未填写")}</dd></div>
        <div><dt>类型</dt><dd>${type}</dd></div>
      </dl>
      ${renderEditableDetails(lesson, false)}
    </article>`;
}

function getSelectedDate() {
  const queryDate = new URLSearchParams(window.location.search).get("date");
  return TEST_DATE || queryDate || formatDate(new Date());
}

function getWeekIndexForDate(date) {
  return schedule.week_ranges.findIndex((range) => date >= range.start_date && date <= range.end_date);
}

function formatWeekDate(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function sortLessons(lessons) {
  return [...lessons].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.start_period - b.start_period) || a.start_time.localeCompare(b.start_time);
  });
}

const CALENDAR_BLOCK_HEIGHT = 170;
const CALENDAR_BLOCKS = [
  { start_period: 1, end_period: 2, label: "07:50–09:30" },
  { start_period: 3, end_period: 4, label: "09:50–11:30" },
  { start_period: 5, end_period: 6, label: "13:30–15:10" },
  { start_period: 7, end_period: 8, label: "15:30–17:10" },
  { start_period: 9, end_period: 10, label: "18:00–19:40" },
  { start_period: 11, end_period: 12, label: "19:50–21:30" }
];

function calendarBlockIndexForPeriod(period) {
  return CALENDAR_BLOCKS.findIndex((block) => (
    period >= block.start_period && period <= block.end_period
  ));
}

function calendarPositionForLesson(lesson) {
  const startBlock = calendarBlockIndexForPeriod(lesson.start_period);
  const endBlock = calendarBlockIndexForPeriod(lesson.end_period);
  if (startBlock < 0 || endBlock < startBlock) {
    throw new Error(`无法将课程节次放入授课时间块：${lesson.period_text}`);
  }
  return {
    top: startBlock * CALENDAR_BLOCK_HEIGHT,
    height: (endBlock - startBlock + 1) * CALENDAR_BLOCK_HEIGHT
  };
}

function renderWeekCalendarLesson(lesson) {
  const detailsId = `calendar-details-${lesson.lesson_id}`;
  const { top, height } = calendarPositionForLesson(lesson);
  const grade = lesson.grade || "未填写";
  const className = String(lesson.class_name || "");
  const repeatedGrade = String(lesson.grade || "").trim();
  const displayClassName = repeatedGrade && className.startsWith(repeatedGrade)
    ? className.slice(repeatedGrade.length).trim()
    : className;
  const time = lesson.start_time && lesson.end_time
    ? `${lesson.start_time}–${lesson.end_time}`
    : "时间待补";

  return `
    <article class="week-calendar-event" style="top: ${top}px; height: ${height}px;">
      <button class="lesson-toggle week-calendar-event-button" type="button" aria-expanded="false" aria-controls="${detailsId}">
        <strong class="calendar-event-grade">${escapeHtml(grade)}</strong>
        <span class="calendar-event-major-class">${escapeHtml(displayClassName)}</span>
        <span class="calendar-event-classroom">${escapeHtml(lesson.classroom || "未填写")}</span>
      </button>
      <div id="${detailsId}" class="week-details calendar-event-details" hidden>
        <dl class="calendar-detail-meta">
          <div><dt>日期</dt><dd>${escapeHtml(lesson.date)}</dd></div>
          <div><dt>上课时间</dt><dd>${escapeHtml(time)}</dd></div>
          <div><dt>节次</dt><dd>${escapeHtml(lesson.period_text)}</dd></div>
          <div><dt>课程名称</dt><dd>${escapeHtml(lesson.course_name)}</dd></div>
          <div><dt>年级</dt><dd>${escapeHtml(grade)}</dd></div>
          <div><dt>专业</dt><dd>${escapeHtml(lesson.major)}</dd></div>
          <div><dt>班级</dt><dd>${escapeHtml(lesson.class_name)}</dd></div>
          <div><dt>教室</dt><dd>${escapeHtml(lesson.classroom || "未填写")}</dd></div>
        </dl>
        ${renderEditableDetails(lesson, true)}
      </div>
    </article>`;
}

function updateViewTabs() {
  viewTabs.forEach((tab) => {
    const active = tab.dataset.view === viewMode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  weekControls.hidden = viewMode !== "week";
}

function renderToday() {
  const selectedDate = getSelectedDate();
  const selectedDay = parseLocalDate(selectedDate);
  const weekday = getWeekday(selectedDay);
  const week = schedule.week_ranges.find((range) => selectedDate >= range.start_date && selectedDate <= range.end_date);

  dateSummary.textContent = `${selectedDate} · ${WEEKDAY_NAMES[weekday]}`;
  if (!week) {
    status.textContent = "当前不在本学期范围内";
    lessonList.innerHTML = `<p class="empty-state">今天没有课程</p>`;
    return;
  }

  status.textContent = `第 ${week.week_number} 周`;
  const lessons = sortLessons(schedule.lessons
    .filter((lesson) => lesson.date === selectedDate)
  );
  lessonList.innerHTML = lessons.length ? lessons.map(renderLesson).join("") : `<p class="empty-state">今天没有课程</p>`;
}

function renderWeek() {
  const week = schedule.week_ranges[selectedWeekIndex];
  const currentIndex = getWeekIndexForDate(getSelectedDate());
  const isCurrentWeekKnown = currentIndex >= 0;
  const weekStart = parseLocalDate(week.start_date);

  dateSummary.textContent = `第${week.week_number}周 · ${week.start_date} ～ ${week.end_date}`;
  status.textContent = "时间轴周视图";
  weekLabel.textContent = `第${week.week_number}周`;
  previousWeek.disabled = selectedWeekIndex === 0;
  nextWeek.disabled = selectedWeekIndex === schedule.week_ranges.length - 1;
  currentWeek.hidden = !isCurrentWeekKnown || selectedWeekIndex === currentIndex;

  const calendarHeight = CALENDAR_BLOCKS.length * CALENDAR_BLOCK_HEIGHT;
  const timeAxis = CALENDAR_BLOCKS.map((block, index) => `
    <span class="calendar-time-label" style="top: ${index * CALENDAR_BLOCK_HEIGHT}px;">${block.label}</span>`).join("");
  const dayHeaders = [];
  const dayColumns = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + offset);
    const date = formatDate(day);
    const lessons = sortLessons(schedule.lessons.filter((lesson) => lesson.date === date));
    const isCurrentDate = date === getSelectedDate();
    const gridLines = CALENDAR_BLOCKS.map((block, index) => `
      <span class="calendar-grid-line" style="top: ${index * CALENDAR_BLOCK_HEIGHT}px;"></span>`).join("");
    dayHeaders.push(`
      <div class="calendar-day-header${isCurrentDate ? " is-current" : ""}">
        <strong>${WEEKDAY_NAMES[offset + 1]}</strong>
        <span>${formatWeekDate(day)}</span>
      </div>`);
    dayColumns.push(`
      <div class="calendar-day-column" style="height: ${calendarHeight}px;">
        ${gridLines}
        ${lessons.map(renderWeekCalendarLesson).join("")}
      </div>`);
  }

  lessonList.innerHTML = `
    <section class="week-calendar" aria-label="第${week.week_number}周时间轴课表">
      <div class="week-calendar-scroll">
        <div class="week-calendar-inner">
          <div class="week-calendar-header">
            <div class="calendar-time-header">时间</div>
            ${dayHeaders.join("")}
          </div>
          <div class="week-calendar-body">
            <div class="calendar-time-axis" style="height: ${calendarHeight}px;">${timeAxis}</div>
            ${dayColumns.join("")}
          </div>
        </div>
      </div>
    </section>`;
}

function renderCurrentView() {
  updateViewTabs();
  if (!schedule) {
    renderNoScheduleState();
    return;
  }
  if (viewMode === "week") renderWeek();
  else renderToday();
}

function setView(nextView) {
  viewMode = nextView;
  renderCurrentView();
}

viewTabs.forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

previousWeek.addEventListener("click", () => {
  if (selectedWeekIndex > 0) {
    selectedWeekIndex -= 1;
    renderWeek();
  }
});

nextWeek.addEventListener("click", () => {
  if (selectedWeekIndex < schedule.week_ranges.length - 1) {
    selectedWeekIndex += 1;
    renderWeek();
  }
});

currentWeek.addEventListener("click", () => {
  const currentIndex = getWeekIndexForDate(getSelectedDate());
  if (currentIndex >= 0) {
    selectedWeekIndex = currentIndex;
    renderWeek();
  }
});

scheduleFile.addEventListener("change", async () => {
  const file = scheduleFile.files && scheduleFile.files[0];
  scheduleFile.value = "";
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json") {
    setImportStatus("课表文件格式不正确，未导入。请选择 .json 文件。", "error");
    return;
  }

  try {
    const candidate = validateSchedule(JSON.parse(await file.text()));
    const confirmed = window.confirm(
      `即将导入：\n${candidate.semester_name}\n教师：${candidate.teacher_name}\n课程：${candidate.lessons.length}节\n\n确认导入？`
    );
    if (!confirmed) {
      setImportStatus("已取消导入。");
      return;
    }
    localStorage.setItem(IMPORTED_SCHEDULE_KEY, JSON.stringify(candidate));
    schedule = candidate;
    renderAfterScheduleChange();
    setImportStatus(`课表导入成功：${candidate.semester_name}，${candidate.lessons.length}节课程。`, "success");
  } catch (error) {
    setImportStatus(error.message || "课表文件格式不正确，未导入。", "error");
  }
});

restoreSchedule.addEventListener("click", () => {
  localStorage.removeItem(IMPORTED_SCHEDULE_KEY);
  schedule = null;
  renderNoScheduleState();
  setImportStatus("当前课表已清除。", "success");
});

lessonList.addEventListener("click", (event) => {
  const toggle = event.target.closest(".lesson-toggle");
  if (toggle) {
    const details = document.getElementById(toggle.getAttribute("aria-controls"));
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    details.hidden = expanded;
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  const lesson = schedule.lessons.find((item) => item.lesson_id === actionButton.dataset.lessonId);
  if (!lesson) return;

  if (action === "edit-content" || action === "edit-note") {
    document.getElementById(actionButton.dataset.editorId).hidden = false;
    return;
  }
  if (action === "cancel-editor") {
    document.getElementById(actionButton.dataset.editorId).hidden = true;
    return;
  }
  if (action === "save-content") {
    const editor = actionButton.closest(".editor-panel");
    const value = editor.querySelector('[data-editor-field="content"]').value;
    persistLessonState(lesson, { teaching_content_override: value });
    renderCurrentView();
    return;
  }
  if (action === "restore-content") {
    persistLessonState(lesson, { teaching_content_override: undefined });
    renderCurrentView();
    return;
  }
  if (action === "save-note") {
    const editor = actionButton.closest(".editor-panel");
    const value = editor.querySelector('[data-editor-field="note"]').value;
    persistLessonState(lesson, { personal_note: value || undefined });
    renderCurrentView();
  }
});

function renderNoScheduleState() {
  dateSummary.textContent = "尚未导入课表";
  status.textContent = "请先点击“导入课表”选择本地 JSON 文件。";
  weekControls.hidden = true;
  lessonList.innerHTML = `
    <section class="empty-state no-schedule-state">
      <strong>尚未导入课表</strong>
      <p>课表只保存在本机浏览器中。</p>
    </section>`;
}

function loadSchedule() {
  const imported = readImportedSchedule();
  if (imported) {
    schedule = imported;
    loadLocalEdits();
    renderAfterScheduleChange();
    setImportStatus(`当前使用本地导入课表：${schedule.semester_name}，${schedule.lessons.length}节课程。`);
    return;
  }
  renderNoScheduleState();
}

loadSchedule();
