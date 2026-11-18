import { query } from "../config/db.js";
import { sendNotificationOnce } from "./notificationService.js";

/**
 * Compliance Supervisor Service
 * -------------------------------------------------------------
 * Automatically enforces:
 * 1. 1-Hour Task View / Acknowledge SLA -> Auto-marks attendance as Absent (locked)
 * 2. 1-Hour Progress Report Reminder -> Sends notification to employee
 * 3. 2-Hour Continuous Hourly Reporting SLA -> Auto-marks attendance as Absent (locked)
 */

export const getCompanyTimezone = async (companyId) => {
  if (!companyId) return "Asia/Kolkata";
  try {
    const res = await query("SELECT settings FROM companies WHERE id = $1", [companyId]);
    const settings = res.rows[0]?.settings;
    if (settings && typeof settings === "object" && settings.timezone) {
      return settings.timezone;
    }
    return "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
};

export const getLocalDateInTz = (timeZone = "Asia/Kolkata") => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().split("T")[0];
  }
};

let isCheckingCompliance = false;

export const checkComplianceNow = async (io = null, targetCompanyId = null) => {
  let attempts = 0;
  while (isCheckingCompliance && attempts < 30) {
    await new Promise(r => setTimeout(r, 200));
    attempts++;
  }
  isCheckingCompliance = true;
  try {
    const taskPenalties = await runTaskUnseenComplianceCheck(io, targetCompanyId);
    const { remindersCount, penaltyCount } = await runHourlyReportingComplianceCheck(io, targetCompanyId);
    return { taskPenalties, remindersCount, penaltyCount };
  } finally {
    isCheckingCompliance = false;
  }
};

/**
 * 1. Check for tasks assigned to employees not viewed/acknowledged within 10 minutes
 */
export const runTaskUnseenComplianceCheck = async (io = null, targetCompanyId = null) => {
  try {
    let sql = `
      SELECT t.id, t.title, t.company_id, t.assigned_to, t.created_at, t.assigned_at, t.deadline,
             u.name as employee_name, u.email as employee_email
      FROM tasks t
      JOIN users u ON t.assigned_to = u.id
      WHERE t.status NOT IN ('completed', 'cancelled', 'suspended')
        AND t.assigned_to IS NOT NULL
        AND t.viewed_at IS NULL
        AND t.acknowledged_at IS NULL
        AND (t.sla_penalty_applied IS FALSE OR t.sla_penalty_applied IS NULL)
        AND COALESCE(t.assigned_at, t.created_at) <= (NOW() - INTERVAL '10 minutes')
        AND (t.deadline IS NULL OR t.deadline > NOW())
        AND (u.status IS NULL OR u.status = 'active')
        AND (u.company_id = t.company_id OR u.company_id IS NULL OR t.company_id IS NULL)
    `;
    const params = [];
    if (targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND t.company_id = $${params.length}`;
    }
    sql += ` ORDER BY COALESCE(t.assigned_at, t.created_at) DESC LIMIT 50`;

    const res = await query(sql, params);
    const violations = res.rows;
    if (violations.length === 0) return 0;

    console.log(`⏱️ [Compliance] Found ${violations.length} task(s) unviewed for > 10 minutes. Applying penalties...`);

    let appliedCount = 0;
    for (const task of violations) {
      // Atomic verification & lock: re-verify task state in case of race conditions
      // (e.g. employee viewed/acknowledged, or task was cancelled/reassigned/completed concurrently)
      const lockRes = await query(
        `UPDATE tasks 
         SET sla_penalty_applied = TRUE, updated_at = NOW() 
         WHERE id = $1 
           AND status NOT IN ('completed', 'cancelled', 'suspended')
           AND assigned_to = $2
           AND viewed_at IS NULL
           AND acknowledged_at IS NULL
           AND (sla_penalty_applied IS FALSE OR sla_penalty_applied IS NULL)
         RETURNING id`,
        [task.id, task.assigned_to]
      );

      if (lockRes.rows.length === 0) {
        // Concurrently acknowledged, completed, cancelled, or already penalized -> skip!
        continue;
      }

      appliedCount++;
      const tz = await getCompanyTimezone(task.company_id);
      const today = getLocalDateInTz(tz);
      const penaltyReason = `Task "${task.title}" was not opened or acknowledged within 10 minutes of assignment.`;

      // Check if employee already has an attendance record today
      const attRes = await query(
        `SELECT id, status, is_admin_locked, penalty_status FROM attendance 
         WHERE user_id = $1 AND (date = $2 OR date = CURRENT_DATE) 
         ORDER BY created_at DESC LIMIT 1`,
        [task.assigned_to, today]
      );

      let attId = null;
      if (attRes.rows.length > 0) {
        attId = attRes.rows[0].id;
        await query(
          `UPDATE attendance
           SET status = 'absent',
               penalty_status = COALESCE(penalty_status, 'unseen_task_penalty'),
               is_admin_locked = TRUE,
               penalty_applied_at = NOW(),
               penalty_reason = COALESCE(penalty_reason, $1),
               penalized_by_task_id = COALESCE(penalized_by_task_id, $2),
               updated_at = NOW()
           WHERE id = $3`,
          [penaltyReason, task.id, attId]
        );
      } else {
        attId = `${task.assigned_to}_${today}`;
        await query(
          `INSERT INTO attendance (
            id, user_id, company_id, date, status, penalty_status,
            is_admin_locked, penalty_applied_at, penalty_reason, penalized_by_task_id,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, 'absent', 'unseen_task_penalty', TRUE, NOW(), $5, $6, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            status = 'absent',
            penalty_status = COALESCE(attendance.penalty_status, 'unseen_task_penalty'),
            is_admin_locked = TRUE,
            penalty_applied_at = NOW(),
            penalty_reason = COALESCE(attendance.penalty_reason, EXCLUDED.penalty_reason),
            penalized_by_task_id = COALESCE(attendance.penalized_by_task_id, EXCLUDED.penalized_by_task_id),
            updated_at = NOW()`,
          [attId, task.assigned_to, task.company_id, today, penaltyReason, task.id]
        );
      }

      // Send Notification to Employee (guaranteed exactly 1 notification)
      await sendNotificationOnce({
        userId: task.assigned_to,
        title: "Attendance Marked Absent (Task Unviewed SLA)",
        message: `You did not view or acknowledge task "${task.title}" within 10 minutes of assignment. Your attendance has been marked Absent and check-in is locked for today. Contact your Admin to resolve.`,
        type: "error",
        link: "/tasks",
        io,
        activityType: "absent_penalty",
        entityId: task.id
      });

      // Send Notification to Admins of this company
      if (task.company_id) {
        const adminsRes = await query(
          `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin', 'superadmin')`,
          [task.company_id]
        );

        for (const admin of adminsRes.rows) {
          if (admin.id === task.assigned_to) continue;
          await sendNotificationOnce({
            userId: admin.id,
            title: "Employee Marked Absent: Task SLA Breach",
            message: `${task.employee_name || "Employee"} did not view task "${task.title}" within 10 minutes. Attendance automatically marked Absent.`,
            type: "warning",
            link: "/admin",
            io,
            activityType: "admin_absent_alert",
            entityId: `${task.assigned_to}_${task.id}`
          });
        }
      }

      // Emit real-time alerts via Socket.IO
      if (io) {
        const payload = {
          attendanceId: attId,
          userId: task.assigned_to,
          companyId: task.company_id,
          employeeName: task.employee_name,
          penaltyType: "unseen_task_penalty",
          penaltyReason,
          taskId: task.id,
          taskTitle: task.title
        };
        io.to(`user_${task.assigned_to}`).emit("attendance_penalty_applied", payload);
        if (task.company_id) io.to(`company_${task.company_id}`).emit("attendance_penalty_applied", payload);
        io.emit("attendance_penalty_applied", payload);
      }
    }

    return appliedCount;
  } catch (err) {
    console.error("❌ [ComplianceSupervisor] runTaskUnseenComplianceCheck error:", err);
    return 0;
  }
};

/**
 * 2. Check for checked-in employees with active assigned tasks for:
 *    - 5-minute progress report reminder (every 5 minutes)
 *    - 10-minute missed report penalty -> Auto-marks attendance as Absent (locked)
 *
 * CRITICAL RULE: Employees with NO active tasks assigned are NEVER penalized or notified!
 */
export const runHourlyReportingComplianceCheck = async (io = null, targetCompanyId = null) => {
  try {
    let penaltyCount = 0;
    let remindersCount = 0;
    const penalizedUsers = new Set();
    const remindedUsers = new Set();

    // 1. Evaluate ONLY employees with genuinely ACTIVE, ELIGIBLE assigned tasks
    let taskSql = `
      SELECT t.id as task_id, t.title as task_title, t.company_id, t.assigned_to, 
             t.viewed_at, t.acknowledged_at, t.assigned_at, t.created_at, t.last_reported_at, 
             t.deadline, t.metadata, t.sla_penalty_applied,
             u.name as employee_name, u.email as employee_email,
             c.settings as company_settings
      FROM tasks t
      JOIN users u ON t.assigned_to = u.id
      LEFT JOIN companies c ON t.company_id = c.id
      WHERE t.status NOT IN ('completed', 'cancelled', 'suspended')
        AND t.assigned_to IS NOT NULL
        AND (t.viewed_at IS NOT NULL OR t.acknowledged_at IS NOT NULL)
        AND (t.sla_penalty_applied IS FALSE OR t.sla_penalty_applied IS NULL)
        AND (u.status IS NULL OR u.status = 'active')
        AND (u.company_id = t.company_id OR u.company_id IS NULL OR t.company_id IS NULL)
    `;
    const taskParams = [];
    if (targetCompanyId) {
      taskParams.push(targetCompanyId);
      taskSql += ` AND t.company_id = $${taskParams.length}`;
    }

    const activeTasksRes = await query(taskSql, taskParams);

    for (const task of activeTasksRes.rows) {
      const tz = await getCompanyTimezone(task.company_id);
      const today = getLocalDateInTz(tz);

      // Check task deadline
      const rawMeta = task.metadata;
      const meta = (rawMeta && typeof rawMeta === 'object') ? rawMeta : (typeof rawMeta === 'string' ? JSON.parse(rawMeta || '{}') : {});
      if (meta.deadlineNotified || task.deadline_notified) {
        continue;
      }
      const candidateDeadlines = [
        task.deadline ? new Date(task.deadline).getTime() : 0,
        meta.deadlineTimestamp ? new Date(meta.deadlineTimestamp).getTime() : 0
      ].filter(ts => ts > 0 && !isNaN(ts));
      const exactDeadline = candidateDeadlines.length > 0 ? new Date(Math.max(...candidateDeadlines)) : null;
      if (exactDeadline && !isNaN(exactDeadline.getTime())) {
        if (Date.now() > exactDeadline.getTime()) {
          // Task deadline has completed; mark metadata so it never notifies again and skip report penalties
          const updatedMeta = { ...meta, deadlineNotified: true, deadlineNotifiedAt: new Date().toISOString() };
          await query(
            `UPDATE tasks SET metadata = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(updatedMeta), task.task_id]
          ).catch(() => {});

          await sendNotificationOnce({
            userId: task.assigned_to,
            title: `Task Deadline Completed: ${task.task_title}`,
            message: `The deadline for task "${task.task_title}" has completed. Action on this task is concluded.`,
            type: "warning",
            link: "/task-management",
            io,
            activityType: "task_deadline_completed",
            entityId: task.task_id,
            taskTitle: task.task_title
          });
          continue;
        }
      }

      // Check if employee is currently checked in today and shift is active:
      const attRes = await query(
        `SELECT id, status, check_in, check_out, is_admin_locked, penalty_status 
         FROM attendance 
         WHERE user_id = $1 AND (date = $2 OR date = CURRENT_DATE)
         ORDER BY created_at DESC LIMIT 1`,
        [task.assigned_to, today]
      );

      const attRecord = attRes.rows[0];
      // Progress reporting applies ONLY during active attendance (checked in and not checked out)
      if (!attRecord || !attRecord.check_in || attRecord.check_out) {
        continue;
      }

      // Find latest report for this employee & task today (isolated strictly per task)
      const repRes = await query(
        `SELECT created_at FROM hourly_reports 
         WHERE user_id = $1 AND task_id = $2 AND (report_date = $3::date OR report_date = CURRENT_DATE)
         ORDER BY created_at DESC LIMIT 1`,
        [task.assigned_to, task.task_id, today]
      );

      const repTime = repRes.rows.length > 0
        ? new Date(repRes.rows[0].created_at).getTime()
        : 0;
      const lastReportedTime = task.last_reported_at
        ? new Date(task.last_reported_at).getTime()
        : 0;
      const unlockTime = meta.unlockedAt
        ? new Date(meta.unlockedAt).getTime()
        : 0;
      const extendTime = meta.extendedAt
        ? new Date(meta.extendedAt).getTime()
        : 0;
      const viewedTime = task.viewed_at
        ? new Date(task.viewed_at).getTime()
        : (task.acknowledged_at ? new Date(task.acknowledged_at).getTime() : 0);
      const checkInTime = new Date(attRecord.check_in).getTime();

      const latestActivity = Math.max(repTime, lastReportedTime, unlockTime, extendTime, viewedTime, checkInTime);
      if (latestActivity === 0 || isNaN(latestActivity)) {
        continue;
      }

      const elapsedMinutes = Math.floor((Date.now() - latestActivity) / (60 * 1000));

      // Rule 1: 5-minute progress report reminder (>= 5 and < 10 minutes)
      if (elapsedMinutes >= 5 && elapsedMinutes < 10 && !remindedUsers.has(task.assigned_to)) {
        const notifResult = await sendNotificationOnce({
          userId: task.assigned_to,
          title: `Task Progress Report Due (5m): ${task.task_title}`,
          message: `5 minutes have passed since your last update on task "${task.task_title}". Please submit your progress report. If you do not report within 10 minutes, your attendance will be marked Absent.`,
          type: "warning",
          link: "/task-management",
          io,
          activityType: "report_reminder",
          entityId: task.task_id,
          taskTitle: task.task_title
        });

        if (notifResult && !notifResult.duplicate) {
          remindersCount++;
        }
        remindedUsers.add(task.assigned_to);
      }

      // Rule 2: 10-Minute Missed Report Violation (>= 10 minutes)
      if (elapsedMinutes >= 10) {
        // Atomic lock on task to prevent race conditions & duplicate penalties
        const taskLock = await query(
          `UPDATE tasks 
           SET sla_penalty_applied = TRUE, updated_at = NOW() 
           WHERE id = $1 
             AND status NOT IN ('completed', 'cancelled', 'suspended')
             AND assigned_to = $2
             AND (sla_penalty_applied IS FALSE OR sla_penalty_applied IS NULL)
           RETURNING id`,
          [task.task_id, task.assigned_to]
        );

        if (taskLock.rows.length === 0) {
          // Concurrently completed, reassigned, cancelled, or already penalized
          continue;
        }

        if (io) {
          io.to(`user_${task.assigned_to}`).emit("task_updated", { id: task.task_id, sla_penalty_applied: true });
          io.emit("task_updated", { id: task.task_id, sla_penalty_applied: true });
        }

        const penaltyReason = `Missed required progress report on task "${task.task_title}" for > 10 minutes (exceeded 10-minute limit).`;

        if (attRecord.status !== "absent" || !attRecord.is_admin_locked) {
          penaltyCount++;
          await query(
            `UPDATE attendance
             SET status = 'absent',
                 penalty_status = COALESCE(penalty_status, 'missed_hourly_report_penalty'),
                 is_admin_locked = TRUE,
                 penalty_applied_at = NOW(),
                 penalty_reason = COALESCE(penalty_reason, $1),
                 penalized_by_task_id = COALESCE(penalized_by_task_id, $2),
                 updated_at = NOW()
             WHERE id = $3`,
            [penaltyReason, task.task_id, attRecord.id]
          );
        }

        if (!penalizedUsers.has(task.assigned_to)) {
          penalizedUsers.add(task.assigned_to);

          // Exactly ONE notification to employee for marking absent
          await sendNotificationOnce({
            userId: task.assigned_to,
            title: "Attendance Marked Absent (Missed Task Report)",
            message: `You have not reported to the admin on task "${task.task_title}" for over 10 minutes. Your attendance has been marked Absent and task actions locked. Contact your Admin to resolve.`,
            type: "error",
            link: "/task-management",
            io,
            activityType: "absent_penalty",
            entityId: task.task_id
          });

          // Exactly ONE notification to Company Admins per employee absent
          if (task.company_id) {
            const adminsRes = await query(
              `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin', 'superadmin')`,
              [task.company_id]
            );

            for (const admin of adminsRes.rows) {
              if (admin.id === task.assigned_to) continue;
              await sendNotificationOnce({
                userId: admin.id,
                title: "Missed Task Report: Attendance Marked Absent",
                message: `${task.employee_name || "Employee"} did not report on task "${task.task_title}" within 10 minutes. Attendance automatically marked Absent and task locked.`,
                type: "warning",
                link: "/task-management",
                io,
                activityType: "admin_absent_alert",
                entityId: `${task.assigned_to}_${task.task_id}`
              });
            }
          }

          // Socket.IO Alert
          if (io) {
            const payload = {
              attendanceId: attRecord.id,
              userId: task.assigned_to,
              companyId: task.company_id,
              employeeName: task.employee_name,
              penaltyType: "missed_hourly_report_penalty",
              penaltyReason,
              taskId: task.task_id,
              taskTitle: task.task_title,
              elapsedMinutes
            };
            io.to(`user_${task.assigned_to}`).emit("attendance_penalty_applied", payload);
            if (task.company_id) io.to(`company_${task.company_id}`).emit("attendance_penalty_applied", payload);
            io.emit("attendance_penalty_applied", payload);
          }
        }
      }
    }

    return { remindersCount, penaltyCount };
  } catch (err) {
    console.error("❌ [ComplianceSupervisor] runHourlyReportingComplianceCheck error:", err);
    return { remindersCount: 0, penaltyCount: 0 };
  }
};

/**
 * Start the background compliance supervisor daemon
 */
export const startComplianceSupervisor = (io, intervalMs = 60000) => {
  console.log("🛡️ [ComplianceSupervisor] Task & Progress Reporting SLA Supervisor started (60s tick).");

  // Initial immediate check
  setTimeout(() => {
    checkComplianceNow(io).catch(() => {});
  }, 3000);

  // Periodic recurring check
  const intervalId = setInterval(() => {
    checkComplianceNow(io).catch(err => {
      console.error("❌ [ComplianceSupervisor] Tick error:", err);
    });
  }, intervalMs);

  return intervalId;
};
