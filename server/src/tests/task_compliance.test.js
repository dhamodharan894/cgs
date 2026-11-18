import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import app from "../app.js";
import { query } from "../config/db.js";
import { generateToken } from "../middlewares/auth.js";
import {
  checkComplianceNow,
  runTaskUnseenComplianceCheck,
  runHourlyReportingComplianceCheck
} from "../services/complianceSupervisor.js";

const PORT = 5098;
let server;
let baseUrl;

const testCompany = "comp_sla_test_corp";
const otherCompany = "comp_sla_other_corp";

const testAdmin = {
  id: "usr_admin_sla_test",
  name: "SLA Admin",
  email: "sla_admin@test.local",
  role: "admin",
  companyId: testCompany
};
const testEmpA = {
  id: "usr_emp_a_sla_test",
  name: "SLA Employee A",
  email: "sla_emp_a@test.local",
  role: "employee",
  companyId: testCompany
};
const testEmpB = {
  id: "usr_emp_b_sla_test",
  name: "SLA Employee B",
  email: "sla_emp_b@test.local",
  role: "employee",
  companyId: testCompany
};
const otherEmp = {
  id: "usr_other_sla_test",
  name: "Other Company Employee",
  email: "other_emp@test.local",
  role: "employee",
  companyId: otherCompany
};

let adminToken;
let empAToken;

describe("Task SLA & Hourly Report Compliance Engine Test Suite", () => {
  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(PORT, resolve));
    baseUrl = `http://localhost:${PORT}/api`;

    // Seed test companies and users
    await query(`INSERT INTO companies (id, name, slug) VALUES ($1, 'SLA Corp', 'sla-corp') ON CONFLICT (id) DO NOTHING`, [testCompany]);
    await query(`INSERT INTO companies (id, name, slug) VALUES ($1, 'Other Corp', 'other-corp') ON CONFLICT (id) DO NOTHING`, [otherCompany]);

    await query(`INSERT INTO users (id, name, email, password_hash, role, company_id) VALUES ($1, $2, $3, 'hashed', 'admin', $4) ON CONFLICT (id) DO NOTHING`, [testAdmin.id, testAdmin.name, testAdmin.email, testCompany]);
    await query(`INSERT INTO users (id, name, email, password_hash, role, company_id) VALUES ($1, $2, $3, 'hashed', 'employee', $4) ON CONFLICT (id) DO NOTHING`, [testEmpA.id, testEmpA.name, testEmpA.email, testCompany]);
    await query(`INSERT INTO users (id, name, email, password_hash, role, company_id) VALUES ($1, $2, $3, 'hashed', 'employee', $4) ON CONFLICT (id) DO NOTHING`, [testEmpB.id, testEmpB.name, testEmpB.email, testCompany]);
    await query(`INSERT INTO users (id, name, email, password_hash, role, company_id) VALUES ($1, $2, $3, 'hashed', 'employee', $4) ON CONFLICT (id) DO NOTHING`, [otherEmp.id, otherEmp.name, otherEmp.email, otherCompany]);

    adminToken = generateToken({ id: testAdmin.id, email: testAdmin.email, role: testAdmin.role, companyId: testCompany });
    empAToken = generateToken({ id: testEmpA.id, email: testEmpA.email, role: testEmpA.role, companyId: testCompany });
  });

  after(async () => {
    // Cleanup test data
    await query(`DELETE FROM tasks WHERE company_id IN ($1, $2)`, [testCompany, otherCompany]);
    await query(`DELETE FROM hourly_reports WHERE company_id IN ($1, $2)`, [testCompany, otherCompany]);
    await query(`DELETE FROM attendance WHERE company_id IN ($1, $2)`, [testCompany, otherCompany]);
    await query(`DELETE FROM notifications WHERE user_id IN ($1, $2, $3, $4)`, [testAdmin.id, testEmpA.id, testEmpB.id, otherEmp.id]);
    await query(`DELETE FROM users WHERE id IN ($1, $2, $3, $4)`, [testAdmin.id, testEmpA.id, testEmpB.id, otherEmp.id]);
    await query(`DELETE FROM companies WHERE id IN ($1, $2)`, [testCompany, otherCompany]);

    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(async () => {
    // Clean tasks, attendance, reports, notifications before each test
    await query(`DELETE FROM tasks WHERE company_id IN ($1, $2)`, [testCompany, otherCompany]);
    await query(`DELETE FROM hourly_reports WHERE company_id IN ($1, $2)`, [testCompany, otherCompany]);
    await query(`DELETE FROM attendance WHERE company_id IN ($1, $2)`, [testCompany, otherCompany]);
    await query(`DELETE FROM notifications WHERE user_id IN ($1, $2, $3, $4)`, [testAdmin.id, testEmpA.id, testEmpB.id, otherEmp.id]);
  });

  // SCENARIO 1: Employee with no task
  it("Scenario 1: Employee with no task -> timeout enforcement runs -> NOT marked absent, attendance NOT locked", async () => {
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s1_" + Date.now();

    // Employee checks in with present status
    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW() - INTERVAL '30 minutes', FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Timeout enforcement runs
    const res = await checkComplianceNow(null, testCompany);
    assert.strictEqual(res.taskPenalties, 0, "No task penalties should apply when no task assigned");
    assert.strictEqual(res.penaltyCount, 0, "No report penalties should apply when no task assigned");

    // Verify attendance is STILL present and NOT locked
    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "present");
    assert.strictEqual(attRow.rows[0].is_admin_locked, false);
    assert.strictEqual(attRow.rows[0].penalty_status, null);

    // Verify no absence notifications sent
    const notifs = await query("SELECT * FROM notifications WHERE user_id = $1", [testEmpA.id]);
    assert.strictEqual(notifs.rows.length, 0);
  });

  // SCENARIO 2: Employee with a valid task and timely acknowledgement
  it("Scenario 2: Employee acknowledges task within 10 minutes -> NOT marked absent", async () => {
    const taskId = "task_s2_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s2_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Task assigned 8 minutes ago, viewed and acknowledged 2 minutes ago
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, assigned_at, created_at)
       VALUES ($1, $2, 'Feature Implementation', $3, $4, 'accepted', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '8 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    const unseenPenalties = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(unseenPenalties, 0, "Acknowledged task must not trigger unseen penalty");

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "present");
    assert.strictEqual(attRow.rows[0].is_admin_locked, false);
  });

  // SCENARIO 3: Employee with valid task and missed acknowledgement deadline (> 10m)
  it("Scenario 3: Employee with valid task misses 10-minute acknowledgement deadline -> marked absent and locked", async () => {
    const taskId = "task_s3_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s3_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Task assigned 15 minutes ago, never viewed/acknowledged
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Urgent Production Fix', $3, $4, 'new', NULL, NULL, FALSE, NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '15 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    const violations = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(violations, 1, "Must penalize exactly 1 unviewed task violation");

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "absent");
    assert.strictEqual(attRow.rows[0].is_admin_locked, true);
    assert.strictEqual(attRow.rows[0].penalty_status, "unseen_task_penalty");
    assert.strictEqual(attRow.rows[0].penalized_by_task_id, taskId);

    // Verify task marked penalized
    const taskRow = await query("SELECT sla_penalty_applied FROM tasks WHERE id = $1", [taskId]);
    assert.strictEqual(taskRow.rows[0].sla_penalty_applied, true);

    // Verify employee received absent notification
    const notifs = await query("SELECT * FROM notifications WHERE user_id = $1", [testEmpA.id]);
    assert.strictEqual(notifs.rows.length, 1);
    assert.ok(notifs.rows[0].title.includes("Attendance Marked Absent"));
  });

  // SCENARIO 4: Task assigned to another employee
  it("Scenario 4: Task assigned to Employee B -> Employee A is NOT penalized", async () => {
    const taskId = "task_s4_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attIdA = "att_s4_a_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attIdA, testEmpA.id, testCompany, today]
    );

    // Task assigned to Employee B (not A), unviewed for 20 minutes
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Task for B', $3, $4, 'new', NULL, NULL, FALSE, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes')`,
      [taskId, testCompany, testEmpB.id, testAdmin.id]
    );

    await runTaskUnseenComplianceCheck(null, testCompany);

    // Employee A MUST remain present and unlocked
    const attRowA = await query("SELECT * FROM attendance WHERE id = $1", [attIdA]);
    assert.strictEqual(attRowA.rows[0].status, "present");
    assert.strictEqual(attRowA.rows[0].is_admin_locked, false);
  });

  // SCENARIO 5: Cancelled task
  it("Scenario 5: Cancelled task -> no task-based absence enforcement", async () => {
    const taskId = "task_s5_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s5_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Task assigned 30 minutes ago, but status is 'cancelled'
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Cancelled Feature', $3, $4, 'cancelled', NULL, NULL, FALSE, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    const violations = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(violations, 0, "Cancelled task must never trigger penalties");

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "present");
    assert.strictEqual(attRow.rows[0].is_admin_locked, false);
  });

  // SCENARIO 6: Reassigned task
  it("Scenario 6: Task reassigned from Employee A to Employee B -> Employee A is NOT penalized", async () => {
    const taskId = "task_s6_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attIdA = "att_s6_a_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attIdA, testEmpA.id, testCompany, today]
    );

    // Task reassigned to Employee B 2 minutes ago
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Reassigned Work', $3, $4, 'new', NULL, NULL, FALSE, NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '20 minutes')`,
      [taskId, testCompany, testEmpB.id, testAdmin.id]
    );

    await runTaskUnseenComplianceCheck(null, testCompany);

    // Employee A must NOT be penalized
    const attRowA = await query("SELECT * FROM attendance WHERE id = $1", [attIdA]);
    assert.strictEqual(attRowA.rows[0].status, "present");
    assert.strictEqual(attRowA.rows[0].is_admin_locked, false);
  });

  // SCENARIO 7: Completed task
  it("Scenario 7: Completed task -> no task-timeout-based absence enforcement", async () => {
    const taskId = "task_s7_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s7_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Task assigned 45 minutes ago, but status is 'completed'
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Finished Work', $3, $4, 'completed', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes', FALSE, NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '45 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    const unseenPenalties = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(unseenPenalties, 0);

    const reportPenalties = await runHourlyReportingComplianceCheck(null, testCompany);
    assert.strictEqual(reportPenalties.penaltyCount, 0);

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "present");
    assert.strictEqual(attRow.rows[0].is_admin_locked, false);
  });

  // SCENARIO 8: Deadline not yet reached (< 10 minutes)
  it("Scenario 8: Task assigned 5 minutes ago (< 10m window) -> no absence enforcement", async () => {
    const taskId = "task_s8_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s8_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Task assigned 5 minutes ago (still in 10-minute acknowledgement window)
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Fresh Task', $3, $4, 'new', NULL, NULL, FALSE, NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    const violations = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(violations, 0, "Task within 10-minute window must not be penalized");

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "present");
    assert.strictEqual(attRow.rows[0].is_admin_locked, false);
  });

  // SCENARIO 9: Progress report timeout with no task
  it("Scenario 9: Employee checked in for 2 hours with NO active tasks -> NOT marked absent and NOT locked", async () => {
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s9_" + Date.now();

    // Checked in 2.5 hours ago with NO tasks assigned
    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW() - INTERVAL '2 hours 30 minutes', FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    const reportRes = await runHourlyReportingComplianceCheck(null, testCompany);
    assert.strictEqual(reportRes.penaltyCount, 0, "No progress report penalty for employee without tasks");
    assert.strictEqual(reportRes.remindersCount, 0, "No progress report reminder for employee without tasks");

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "present");
    assert.strictEqual(attRow.rows[0].is_admin_locked, false);
    assert.strictEqual(attRow.rows[0].penalty_status, null);

    const notifs = await query("SELECT * FROM notifications WHERE user_id = $1", [testEmpA.id]);
    assert.strictEqual(notifs.rows.length, 0);
  });

  // SCENARIO 10: Duplicate enforcement
  it("Scenario 10: Timeout job runs multiple times for the same missed task -> NO duplicate penalties", async () => {
    const taskId = "task_s10_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s10_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Single Penalty Task', $3, $4, 'new', NULL, NULL, FALSE, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    // Run 1st time -> applies 1 penalty
    const run1 = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(run1, 1);

    // Run 2nd time -> must NOT re-penalize or create duplicate records
    const run2 = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(run2, 0, "Second run must apply 0 penalties");

    // Run 3rd time
    const run3 = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(run3, 0, "Third run must apply 0 penalties");

    // Exactly 1 attendance record exists
    const allAtt = await query("SELECT * FROM attendance WHERE user_id = $1 AND company_id = $2", [testEmpA.id, testCompany]);
    assert.strictEqual(allAtt.rows.length, 1);

    // Exactly 1 notification delivered
    const notifs = await query("SELECT * FROM notifications WHERE user_id = $1", [testEmpA.id]);
    assert.strictEqual(notifs.rows.length, 1);
  });

  // SCENARIO 11: Tenant/company isolation
  it("Scenario 11: Task in Company A does NOT trigger attendance enforcement for Employee in Company B", async () => {
    const taskId = "task_s11_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attIdOther = "att_s11_other_" + Date.now();

    // Employee in Company B is checked in
    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attIdOther, otherEmp.id, otherCompany, today]
    );

    // Task created in Company A for Employee A (unviewed 30 mins)
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Company A Task', $3, $4, 'new', NULL, NULL, FALSE, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    // Run compliance supervisor scoped ONLY to Company B
    const compBRes = await checkComplianceNow(null, otherCompany);
    assert.strictEqual(compBRes.taskPenalties, 0);
    assert.strictEqual(compBRes.penaltyCount, 0);

    // Company B Employee must NOT be affected
    const attRowOther = await query("SELECT * FROM attendance WHERE id = $1", [attIdOther]);
    assert.strictEqual(attRowOther.rows[0].status, "present");
    assert.strictEqual(attRowOther.rows[0].is_admin_locked, false);
  });

  // SCENARIO 12: Race condition
  it("Scenario 12: Task acknowledged right at enforcement time -> safely evaluated atomically with no false penalty", async () => {
    const taskId = "task_s12_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s12_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW(), FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Task assigned 12 minutes ago
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Concurrent Task', $3, $4, 'new', NULL, NULL, FALSE, NOW() - INTERVAL '12 minutes', NOW() - INTERVAL '12 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    // Simulate concurrent employee acknowledgement right as job triggers
    await query(
      `UPDATE tasks SET viewed_at = NOW(), acknowledged_at = NOW(), status = 'accepted' WHERE id = $1`,
      [taskId]
    );

    // Compliance check runs
    const res = await runTaskUnseenComplianceCheck(null, testCompany);
    assert.strictEqual(res, 0, "Concurrently acknowledged task must not be penalized");

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "present");
    assert.strictEqual(attRow.rows[0].is_admin_locked, false);
  });

  // PROGRESS REPORTING SLA FOR VALID ACTIVE TASK
  it("Scenario 13: Valid active task with missed progress report (> 10m) -> marked absent and locked", async () => {
    const taskId = "task_s13_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s13_" + Date.now();

    // Employee checked in 1 hour ago
    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW() - INTERVAL '1 hour', FALSE)`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Active accepted task viewed 20 minutes ago, no reports submitted
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, acknowledged_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Sprint Core Task', $3, $4, 'accepted', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes', FALSE, NOW() - INTERVAL '25 minutes', NOW() - INTERVAL '25 minutes')`,
      [taskId, testCompany, testEmpA.id, testAdmin.id]
    );

    const reportRes = await runHourlyReportingComplianceCheck(null, testCompany);
    assert.strictEqual(reportRes.penaltyCount, 1, "Must penalize missed progress report on active task");

    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "absent");
    assert.strictEqual(attRow.rows[0].is_admin_locked, true);
    assert.strictEqual(attRow.rows[0].penalty_status, "missed_hourly_report_penalty");
    assert.strictEqual(attRow.rows[0].penalized_by_task_id, taskId);
  });

  // ADMIN UNLOCK / REVERT PENALTY RESTORES PRESENT STATUS
  it("Scenario 14: Admin reverts penalty -> restores Present status and lifts lock", async () => {
    const taskId = "task_s14_" + Date.now();
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_s14_" + Date.now();

    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked, penalty_status, penalty_reason)
       VALUES ($1, $2, $3, $4, 'absent', NOW() - INTERVAL '1 hour', TRUE, 'missed_hourly_report_penalty', 'Test penalty')`,
      [attId, testEmpA.id, testCompany, today]
    );

    // Admin reverts penalty
    const revertRes = await fetch(`${baseUrl}/attendance/${attId}/revert-penalty`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ resolutionNotes: "Granted exception" })
    });
    assert.strictEqual(revertRes.status, 200);
    const body = await revertRes.json();
    assert.strictEqual(body.attendance.status, "present");
    assert.strictEqual(body.attendance.is_admin_locked, false);
    assert.strictEqual(body.attendance.penalty_status, null);
  });
});
