#[test_only]
// take_shared 取不可变借用，但同一作用域常并用 ts::ctx(&mut s)，故沿用 &mut s 习惯写法；
// 这两个 lint（未实际可变使用的 &mut）在 Sui 测试套件里属常态，模块级静音。
#[allow(unused_mut_ref, unused_mut_parameter)]
module isub::subscription_tests;

use isub::subscription::{
    Self as sub,
    Account,
    Plan,
    Mandate,
};
use sui::test_scenario::{Self as ts, Scenario};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};

// ===== 测试币 =====
public struct TEST_USD has drop {}

// ===== 角色地址（纯 hex；M/K 等非 hex 字符不可用于地址字面量）=====
const MERCHANT: address = @0x6E6C;   // "merchant"
const USER: address = @0x05E2;       // "user"
const KEEPER: address = @0xCEE9;     // "keeper"
const ATTACKER: address = @0xBAD;    // "bad"

// ===== 错误码（镜像合约里的私有 const；用于 expected_failure 断言精确码）=====
// 合约的 const 是 private，跨模块无法直接引用，故在此按数值镜像。
const ENotOwner: u64 = 1;
const ENotSubscriber: u64 = 2;
const ENotAuthorizedCharger: u64 = 3;
const ENotActive: u64 = 4;
const EExpired: u64 = 5;
const EIntervalNotElapsed: u64 = 6;
const EWrongAmount: u64 = 7;
const EOverRateCap: u64 = 8;
const EOverTotalBudget: u64 = 9;
const EInsufficientAccount: u64 = 10;
const EZeroPrice: u64 = 14;
const EZeroInterval: u64 = 15;
const EZeroRateCap: u64 = 16;
const EZeroRateWindow: u64 = 17;
const EZeroBudget: u64 = 18;
const EBadExpiry: u64 = 19;
const EAccountMismatch: u64 = 13;
const EBadMode: u64 = 12;
const EBadChargeSeq: u64 = 20;
const ERefundExceedsSpent: u64 = 21;
const ENotMerchant: u64 = 22;
const ETermsMismatch: u64 = 23;
const EOverMaxPerCharge: u64 = 24;
const EZeroMaxPerCharge: u64 = 25;
const EPlanInactive: u64 = 11;
const ENotPlanMerchant: u64 = 26;
const EWrongVersion: u64 = 27;
const EAccountNotEmpty: u64 = 28;
const EMandateNotRevoked: u64 = 29;

// 常用时间量
const INTERVAL: u64 = 1000;        // fixed 计费周期 (ms)
const RATE_WINDOW: u64 = 1000;     // payg 速率窗口 (ms)
const EXPIRY: u64 = 1_000_000;     // mandate 到期 (ms)

// ===== 助手 =====

fun new_clock(s: &mut Scenario): Clock {
    clock::create_for_testing(ts::ctx(s))
}

/// 给指定地址造币并存入其拥有的 Account（需在该地址的 tx 内调用）。
fun deposit_amount(s: &mut Scenario, amount: u64) {
    let mut acct = ts::take_shared<Account<TEST_USD>>(s);
    let c = coin::mint_for_testing<TEST_USD>(amount, ts::ctx(s));
    sub::deposit(&mut acct, c);
    ts::return_shared(acct);
}

/// 建立一个 FIXED 场景：USER 开户并存入 `deposit`，MERCHANT 建 fixed plan，
/// USER authorize（budget=`budget`，expiry=EXPIRY）。
/// 时钟起始 t=0；authorize 后 last_charged 会被设到 max(0, now-interval)=0 → 首扣立即可行。
/// 返回时：Account / Plan / Mandate 均为 shared，可在后续 tx 取出。
fun setup_fixed(s: &mut Scenario, deposit: u64, price: u64, budget: u64, clock: &Clock) {
    // USER 开户
    ts::next_tx(s, USER);
    sub::open_account<TEST_USD>(ts::ctx(s));
    // USER 充值
    ts::next_tx(s, USER);
    deposit_amount(s, deposit);
    // MERCHANT 建套餐
    ts::next_tx(s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(price, INTERVAL, KEEPER, ts::ctx(s));
    // USER 授权（H-1：签名携带条款回声 price/INTERVAL；首扣延迟 0 = 现行为）
    ts::next_tx(s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(s);
        let plan = ts::take_shared<Plan<TEST_USD>>(s);
        sub::authorize_fixed<TEST_USD>(&acct, &plan, price, INTERVAL, MERCHANT, budget, EXPIRY, 0, clock, ts::ctx(s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
}

/// 建立一个 PAYG 场景。
fun setup_payg(s: &mut Scenario, deposit: u64, rate_cap: u64, budget: u64, clock: &Clock) {
    ts::next_tx(s, USER);
    sub::open_account<TEST_USD>(ts::ctx(s));
    ts::next_tx(s, USER);
    deposit_amount(s, deposit);
    ts::next_tx(s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(rate_cap, RATE_WINDOW, KEEPER, ts::ctx(s));
    // H-1：条款回声 rate_cap/RATE_WINDOW；max_per_charge 取 rate_cap（不额外设限，
    // 保持存量测试行为）；首扣延迟 0。
    ts::next_tx(s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(s);
        let plan = ts::take_shared<Plan<TEST_USD>>(s);
        sub::authorize_metered<TEST_USD>(&acct, &plan, rate_cap, RATE_WINDOW, MERCHANT, KEEPER, budget, EXPIRY, rate_cap, 0, clock, ts::ctx(s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
}

/// 断言某地址当前持有的 Coin<TEST_USD> 总额 == expected（消费它们，避免悬挂）。
/// 必须在该地址的 tx 上下文里调用。
fun assert_addr_received(s: &mut Scenario, expected: u64) {
    let mut total = 0u64;
    while (ts::has_most_recent_for_sender<Coin<TEST_USD>>(s)) {
        let c = ts::take_from_sender<Coin<TEST_USD>>(s);
        total = total + coin::value(&c);
        coin::burn_for_testing(c);
    };
    assert!(total == expected, 100);
}

// =====================================================================
// Phase 1 — 功能测试 FN-1..FN-7（证明"能用"，断言精确数值）
// =====================================================================

// FN-1: open→deposit(100)→withdraw(30)→withdraw_all。balance 100→70→0；用户收 30、70。
#[test]
fun fn1_account_deposit_withdraw_conservation() {
    let mut s = ts::begin(USER);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));

    // deposit 100
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let c = coin::mint_for_testing<TEST_USD>(100, ts::ctx(&mut s));
        sub::deposit(&mut acct, c);
        assert!(sub::account_balance(&acct) == 100, 0);
        ts::return_shared(acct);
    };

    // withdraw 30 → balance 70；USER 收到 30
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let out = sub::withdraw(&mut acct, 30, ts::ctx(&mut s));
        assert!(coin::value(&out) == 30, 1);
        assert!(sub::account_balance(&acct) == 70, 2);
        transfer::public_transfer(out, USER);
        ts::return_shared(acct);
    };
    // 校验 USER 真收到 30
    ts::next_tx(&mut s, USER);
    assert_addr_received(&mut s, 30);

    // withdraw_all → balance 0；USER 收到 70
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let out = sub::withdraw_all(&mut acct, ts::ctx(&mut s));
        assert!(coin::value(&out) == 70, 3);
        assert!(sub::account_balance(&acct) == 0, 4);
        transfer::public_transfer(out, USER);
        ts::return_shared(acct);
    };
    ts::next_tx(&mut s, USER);
    assert_addr_received(&mut s, 70);

    ts::end(s);
}

// FN-2: deposit(100)→authorize 后 balance 仍 == 100（不变量 #10：无预储值）。
#[test]
fun fn2_authorize_moves_no_funds() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        // authorize 后余额不变
        assert!(sub::account_balance(&acct) == 100, 0);
        ts::return_shared(acct);
    };
    // mandate 存在且 spent_total==0
    ts::next_tx(&mut s, USER);
    {
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        assert!(sub::mandate_spent(&m) == 0, 1);
        assert!(sub::mandate_status(&m) == sub::status_active(), 2);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// FN-3 ★核心: deposit(100), fixed price=10, 过 interval, charge。
// 商家收 10；account==90；spent_total==10；last_charged 前进。
#[test]
fun fn3_fixed_charge_core() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // 推进一个 interval 使首扣后的下一扣可行（首扣 last=0，now 需 >= interval）
    clock::increment_for_testing(&mut clock, INTERVAL);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::account_balance(&acct) == 90, 0);
        assert!(sub::mandate_spent(&m) == 10, 1);
        // last_charged 前进到 now (=INTERVAL)
        assert!(sub::mandate_last_charged(&m) == INTERVAL, 2);
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // 商家确实收到 10
    ts::next_tx(&mut s, MERCHANT);
    assert_addr_received(&mut s, 10);

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// FN-4: 连续 3 个 interval 各 charge 一次。商家共收 30；account==70；spent_total==30。
#[test]
fun fn4_fixed_three_intervals() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    let mut i = 0u64;
    while (i < 3) {
        clock::increment_for_testing(&mut clock, INTERVAL);
        ts::next_tx(&mut s, MERCHANT);
        {
            let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
            let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
            sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
            ts::return_shared(acct);
            ts::return_shared(m);
        };
        i = i + 1;
    };

    ts::next_tx(&mut s, MERCHANT);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        assert!(sub::account_balance(&acct) == 70, 0);
        assert!(sub::mandate_spent(&m) == 30, 1);
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // 商家累计收到 30（三次转账聚合）
    ts::next_tx(&mut s, MERCHANT);
    assert_addr_received(&mut s, 30);

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// FN-5: deposit(100), PAYG rate_cap=50, charge(7)+charge(8)。
// 商家收 15；account==85；window_spent==15。
#[test]
fun fn5_payg_two_charges() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    // 同一窗口内两次 charge（无需推进时间）
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 7, 0, &clock, ts::ctx(&mut s));
        sub::charge_metered(&mut acct, &mut m, 8, 1, &clock, ts::ctx(&mut s));
        assert!(sub::account_balance(&acct) == 85, 0);
        assert!(sub::mandate_window_spent(&m) == 15, 1);
        assert!(sub::mandate_spent(&m) == 15, 2);
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    ts::next_tx(&mut s, MERCHANT);
    assert_addr_received(&mut s, 15);

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// FN-6 ★e2e: open→deposit→create_plan→authorize→charge×2→revoke→withdraw。每步断言。
#[test]
fun fn6_end_to_end() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    // open + deposit 100 + plan(price=10) + authorize(budget=100)
    setup_fixed(&mut s, 100, 10, 100, &clock);

    // charge #1（t=INTERVAL）
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::account_balance(&acct) == 90, 0);
        assert!(sub::mandate_spent(&m) == 10, 1);
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    // charge #2（t=2*INTERVAL）
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::account_balance(&acct) == 80, 2);
        assert!(sub::mandate_spent(&m) == 20, 3);
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // 商家累计收到 20
    ts::next_tx(&mut s, MERCHANT);
    assert_addr_received(&mut s, 20);

    // USER revoke
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::revoke(&mut m, ts::ctx(&mut s));
        assert!(sub::mandate_status(&m) == sub::status_revoked(), 4);
        ts::return_shared(m);
    };

    // USER withdraw_all 取回剩余 80
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let out = sub::withdraw_all(&mut acct, ts::ctx(&mut s));
        assert!(coin::value(&out) == 80, 5);
        assert!(sub::account_balance(&acct) == 0, 6);
        transfer::public_transfer(out, USER);
        ts::return_shared(acct);
    };
    ts::next_tx(&mut s, USER);
    assert_addr_received(&mut s, 80);

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// FN-7: 一个 Account 授权两个商家，各自 charge。account 正确递减、互不串款。
// 商家 A=MERCHANT(price=10)，商家 B=KEEPER 复用作第二商家(price=20)。
// 用 mandate_merchant getter 精确识别每个 mandate，对其 charge 自己的价格，
// 并断言：账户递减 30、A 收 10、B 收 20（互不串款）。
#[test]
fun fn7_two_merchants_one_account() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    // USER 开户 + 充 100
    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    deposit_amount(&mut s, 100);

    // 商家 A (MERCHANT) 建 plan price=10
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    // 商家 B (KEEPER 作为第二个独立商家地址) 建 plan price=20
    ts::next_tx(&mut s, KEEPER);
    sub::create_plan_fixed<TEST_USD>(20, INTERVAL, MERCHANT, ts::ctx(&mut s));

    // USER 对两个 plan 各授权一次
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let p1 = ts::take_shared<Plan<TEST_USD>>(&mut s);
        let p2 = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_fixed<TEST_USD>(&acct, &p1, sub::plan_price(&p1), sub::plan_interval(&p1), sub::plan_merchant(&p1), 1000, EXPIRY, 0, &clock, ts::ctx(&mut s));
        sub::authorize_fixed<TEST_USD>(&acct, &p2, sub::plan_price(&p2), sub::plan_interval(&p2), sub::plan_merchant(&p2), 1000, EXPIRY, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(p1);
        ts::return_shared(p2);
    };

    clock::increment_for_testing(&mut clock, INTERVAL);

    // 取出两个 mandate，用 merchant 字段识别后各扣其价格。
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m1 = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let mut m2 = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        // 各自的正确金额：merchant==MERCHANT → 10；merchant==KEEPER → 20
        let amt1 = if (sub::mandate_merchant(&m1) == MERCHANT) { 10 } else { 20 };
        let amt2 = if (sub::mandate_merchant(&m2) == MERCHANT) { 10 } else { 20 };
        sub::charge(&mut acct, &mut m1, amt1, &clock, ts::ctx(&mut s));
        sub::charge(&mut acct, &mut m2, amt2, &clock, ts::ctx(&mut s));
        // 账户递减 30
        assert!(sub::account_balance(&acct) == 70, 0);
        // 每个 mandate 只扣了自己的价格
        assert!(sub::mandate_spent(&m1) == amt1, 1);
        assert!(sub::mandate_spent(&m2) == amt2, 2);
        ts::return_shared(acct);
        ts::return_shared(m1);
        ts::return_shared(m2);
    };

    // 商家 A (MERCHANT) 精确收到 10
    ts::next_tx(&mut s, MERCHANT);
    assert_addr_received(&mut s, 10);
    // 商家 B (KEEPER) 精确收到 20（互不串款）
    ts::next_tx(&mut s, KEEPER);
    assert_addr_received(&mut s, 20);

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// =====================================================================
// Phase 2 — 回归/安全测试
// =====================================================================

// ---- F-01 单笔 PTB 累积抽干 ----

// F01-1: 闲置多个 interval 后，同一 tx 内连扣两次。第二次 abort EIntervalNotElapsed。
#[test, expected_failure(abort_code = EIntervalNotElapsed, location = isub::subscription)]
fun f01_1_double_charge_same_tx_aborts() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // 闲置 5 个 interval
    clock::increment_for_testing(&mut clock, INTERVAL * 5);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        // 第一次成功（last 置 now）
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        // 同一 tx now 不变 → 第二次 now >= now+interval 失败
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// F01-2a: 扣后推进 <interval 再扣 → abort。
#[test, expected_failure(abort_code = EIntervalNotElapsed, location = isub::subscription)]
fun f01_2a_charge_before_interval_aborts() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // 仅推进半个 interval
    clock::increment_for_testing(&mut clock, INTERVAL / 2);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// F01-2b: 扣后推进 ≥interval 再扣 → 成功（严格一周期一扣的正向）。
#[test]
fun f01_2b_charge_after_interval_succeeds() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // 再推进一个完整 interval
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_spent(&m) == 20, 0);
        assert!(sub::account_balance(&acct) == 80, 1);
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// ---- F-02 输入校验 ----

#[test, expected_failure(abort_code = EZeroPrice, location = isub::subscription)]
fun f02_1_plan_fixed_zero_price() {
    let mut s = ts::begin(MERCHANT);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(0, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::end(s);
}

#[test, expected_failure(abort_code = EZeroInterval, location = isub::subscription)]
fun f02_2_plan_fixed_zero_interval() {
    let mut s = ts::begin(MERCHANT);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, 0, KEEPER, ts::ctx(&mut s));
    ts::end(s);
}

#[test, expected_failure(abort_code = EZeroRateCap, location = isub::subscription)]
fun f02_3_plan_payg_zero_rate_cap() {
    let mut s = ts::begin(MERCHANT);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(0, RATE_WINDOW, KEEPER, ts::ctx(&mut s));
    ts::end(s);
}

#[test, expected_failure(abort_code = EZeroRateWindow, location = isub::subscription)]
fun f02_4_plan_payg_zero_rate_window() {
    let mut s = ts::begin(MERCHANT);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, 0, KEEPER, ts::ctx(&mut s));
    ts::end(s);
}

#[test, expected_failure(abort_code = EZeroBudget, location = isub::subscription)]
fun f02_5_authorize_zero_budget() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    deposit_amount(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 10, INTERVAL, MERCHANT, 0, EXPIRY, 0, &clock, ts::ctx(&mut s)); // abort EZeroBudget
        ts::return_shared(acct);
        ts::return_shared(plan);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

#[test, expected_failure(abort_code = EBadExpiry, location = isub::subscription)]
fun f02_6_authorize_past_expiry() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);
    // 把时钟推进到 5000，再用 expiry=4000（过去）
    clock::increment_for_testing(&mut clock, 5000);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    deposit_amount(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 10, INTERVAL, MERCHANT, 1000, 4000, 0, &clock, ts::ctx(&mut s)); // abort EBadExpiry
        ts::return_shared(acct);
        ts::return_shared(plan);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// ---- F-03 暂停=豁免不是延期 ----

// F03-1: charge→pause→推进数个 interval→resume→立刻 charge → abort；再推进一个 interval→成功。
// 这里拆成两个测试：F03_1_aborts（必败）与 F03_1_then_ok（正向）。
#[test, expected_failure(abort_code = EIntervalNotElapsed, location = isub::subscription)]
fun f03_1_resume_then_immediate_charge_aborts() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // charge #1
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // USER pause
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::pause(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    // 推进 5 个 interval（暂停期）
    clock::increment_for_testing(&mut clock, INTERVAL * 5);
    // USER resume（应把 last_charged 拉到 now）
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::resume(&mut m, &clock, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    // 立刻 charge（同一时刻，未过新 interval）→ abort
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// F03-1 正向续：resume 后再推进一个完整 interval → charge 成功（且暂停期未被追扣）。
#[test]
fun f03_1_resume_then_one_interval_ok() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::pause(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    clock::increment_for_testing(&mut clock, INTERVAL * 5);
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::resume(&mut m, &clock, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    // 推进一个完整 interval 后 charge 成功
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        // 暂停期未被追扣：只扣了两次共 20
        assert!(sub::mandate_spent(&m) == 20, 0);
        assert!(sub::account_balance(&acct) == 80, 1);
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// F03-2: PAYG pause→推进→resume → window_spent 归零、window_start=now。
#[test]
fun f03_2_payg_resume_resets_window() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    // 先在窗口内消费 15
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 15, 0, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_window_spent(&m) == 15, 0);
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // pause
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::pause(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    // 推进时间到 t=500（仍在原窗口内，证明 resume 主动重置而非靠窗口自然滚动）
    clock::increment_for_testing(&mut clock, 500);
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::resume(&mut m, &clock, ts::ctx(&mut s));
        // window_spent 归零、window_start 推到 now(=500)
        assert!(sub::mandate_window_spent(&m) == 0, 1);
        assert!(sub::mandate_window_start(&m) == 500, 2);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// ---- E. 不变量 / 访问控制 必须 abort ----

// E1: Fixed charge amount≠price → EWrongAmount。
#[test, expected_failure(abort_code = EWrongAmount, location = isub::subscription)]
fun e1_fixed_wrong_amount() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 11, &clock, ts::ctx(&mut s)); // ≠ price 10
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E2: PAYG 窗口内累计超 rate_cap → EOverRateCap。
#[test, expected_failure(abort_code = EOverRateCap, location = isub::subscription)]
fun e2_payg_over_rate_cap() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 30, 0, &clock, ts::ctx(&mut s));
        // 累计 30+25=55 > cap 50 → abort
        sub::charge_metered(&mut acct, &mut m, 25, 1, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E3: 累计 charge 超 total_budget → EOverTotalBudget。
// 用 PAYG，rate_cap 足够大，budget 设小，使 budget 先于 cap 触发。
#[test, expected_failure(abort_code = EOverTotalBudget, location = isub::subscription)]
fun e3_over_total_budget() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    // rate_cap=1000（不挡），budget=40
    setup_payg(&mut s, 100, 1000, 40, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 30, 0, &clock, ts::ctx(&mut s));
        // 累计 30+20=50 > budget 40 → abort
        sub::charge_metered(&mut acct, &mut m, 20, 1, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E4: now≥expiry 时 charge → EExpired。
#[test, expected_failure(abort_code = EExpired, location = isub::subscription)]
fun e4_charge_after_expiry() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    // 推进到 >= EXPIRY
    clock::increment_for_testing(&mut clock, EXPIRY);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort EExpired
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E5: revoke 后 charge → ENotActive。
#[test, expected_failure(abort_code = ENotActive, location = isub::subscription)]
fun e5_charge_after_revoke() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::revoke(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort ENotActive
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E6: paused 时 charge → ENotActive。
#[test, expected_failure(abort_code = ENotActive, location = isub::subscription)]
fun e6_charge_while_paused() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::pause(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort ENotActive
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E7: charge amount > Account 余额 → EInsufficientAccount。
// 用 PAYG，cap/budget 足够大，但 account 余额不足。
#[test, expected_failure(abort_code = EInsufficientAccount, location = isub::subscription)]
fun e7_charge_exceeds_balance() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    // 只存 5，cap=1000，budget=1000
    setup_payg(&mut s, 5, 1000, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 10, 0, &clock, ts::ctx(&mut s)); // 10 > 余额 5
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E8: charge 传入不匹配的 Account → EAccountMismatch。
// 用 ATTACKER 另开一个账户（与原 mandate.account_id 不同），对原 mandate charge。
#[test, expected_failure(abort_code = EAccountMismatch, location = isub::subscription)]
fun e8_charge_account_mismatch() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    // 第一个账户(USER) + plan + mandate（PAYG）
    setup_payg(&mut s, 100, 50, 1000, &clock);

    // ATTACKER 开第二个账户并充值（owner=ATTACKER，与 mandate.account_id 不同）
    ts::next_tx(&mut s, ATTACKER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, ATTACKER);
    {
        // ATTACKER 的账户是 ATTACKER 最近创建的那个
        let mut acct2 = ts::take_shared<Account<TEST_USD>>(&mut s);
        assert!(sub::account_owner(&acct2) == ATTACKER, 99); // 确认取到的是第二个账户
        let c = coin::mint_for_testing<TEST_USD>(100, ts::ctx(&mut s));
        sub::deposit(&mut acct2, c);
        ts::return_shared(acct2);
    };

    // 用第二个账户(owner=ATTACKER)对原 mandate charge → account_id 不匹配
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let mandate_acct = sub::mandate_account_id(&m);
        let mut a1 = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut a2 = ts::take_shared<Account<TEST_USD>>(&mut s);
        // 对不匹配的那个账户调 charge（无论 a1 还是 a2 匹配，都挑另一个）
        if (object::id(&a1) == mandate_acct) {
            // a1 匹配 → 用 a2（不匹配）触发 abort
            sub::charge(&mut a2, &mut m, 10, &clock, ts::ctx(&mut s));
        } else {
            // a1 不匹配 → 直接用 a1 触发 abort
            sub::charge(&mut a1, &mut m, 10, &clock, ts::ctx(&mut s));
        };
        ts::return_shared(a1);
        ts::return_shared(a2);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E9: PAYG charge 由非 merchant/keeper 调 → ENotAuthorizedCharger。
#[test, expected_failure(abort_code = ENotAuthorizedCharger, location = isub::subscription)]
fun e9_payg_unauthorized_charger() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    // ATTACKER（非 merchant 非 keeper）尝试 charge
    ts::next_tx(&mut s, ATTACKER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 10, 0, &clock, ts::ctx(&mut s)); // abort
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// E10: withdraw 由非 owner 调 → ENotOwner。
#[test, expected_failure(abort_code = ENotOwner, location = isub::subscription)]
fun e10_withdraw_not_owner() {
    let mut s = ts::begin(USER);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    deposit_amount(&mut s, 100);

    // ATTACKER 尝试取款
    ts::next_tx(&mut s, ATTACKER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let out = sub::withdraw(&mut acct, 10, ts::ctx(&mut s)); // abort ENotOwner
        transfer::public_transfer(out, ATTACKER);
        ts::return_shared(acct);
    };

    ts::end(s);
}

// E11: revoke 由非 subscriber 调 → ENotSubscriber。
#[test, expected_failure(abort_code = ENotSubscriber, location = isub::subscription)]
fun e11_revoke_not_subscriber() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, ATTACKER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::revoke(&mut m, ts::ctx(&mut s)); // abort ENotSubscriber
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// ---- F. 退出权 + 有界损失 ----

// F1: 活跃 mandate 下用户随时 withdraw → 成功（退出权不被阻挡）。
#[test]
fun f1_withdraw_under_active_mandate() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // mandate 处于 active，USER 直接 withdraw 50
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let out = sub::withdraw(&mut acct, 50, ts::ctx(&mut s));
        assert!(coin::value(&out) == 50, 0);
        assert!(sub::account_balance(&acct) == 50, 1);
        transfer::public_transfer(out, USER);
        ts::return_shared(acct);
    };
    ts::next_tx(&mut s, USER);
    assert_addr_received(&mut s, 50);

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// F2: withdraw_all 清空后 charge → EInsufficientAccount。
#[test, expected_failure(abort_code = EInsufficientAccount, location = isub::subscription)]
fun f2_withdraw_all_then_charge() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // USER 清空账户
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let out = sub::withdraw_all(&mut acct, ts::ctx(&mut s));
        transfer::public_transfer(out, USER);
        ts::return_shared(acct);
    };
    // 过 interval 后商家尝试 charge → 余额 0 不足
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// F3 ★: 恶意商家反复扣到 total_budget。spent_total 封顶；再扣 abort EOverTotalBudget。
// PAYG，cap 足够大，budget=30；扣 30 后再扣必败。
#[test, expected_failure(abort_code = EOverTotalBudget, location = isub::subscription)]
fun f3_budget_cap_bounds_loss() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 1000, 30, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        // 扣满 budget 30
        sub::charge_metered(&mut acct, &mut m, 30, 0, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_spent(&m) == 30, 0);
        // 再扣 1 → 31 > 30 abort
        sub::charge_metered(&mut acct, &mut m, 1, 1, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// =====================================================================
// Phase 3 — 资金正确性强化：N-1 计量幂等 / N-2 退款
// =====================================================================

// N1-1: charge_metered 携带正确 seq 连扣两次 → seq 0→1→2、金额准确。
#[test]
fun n1_1_metered_seq_advances() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        assert!(sub::mandate_charge_seq(&m) == 0, 0);
        sub::charge_metered(&mut acct, &mut m, 7, 0, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_charge_seq(&m) == 1, 1);
        sub::charge_metered(&mut acct, &mut m, 8, 1, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_charge_seq(&m) == 2, 2);
        assert!(sub::mandate_spent(&m) == 15, 3);
        assert!(sub::account_balance(&acct) == 85, 4);
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N1-2 ★核心: 同一账单超时重试（重放同一 seq）→ EBadChargeSeq。双扣不可能。
#[test, expected_failure(abort_code = EBadChargeSeq, location = isub::subscription)]
fun n1_2_metered_replay_aborts() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 7, 0, &clock, ts::ctx(&mut s));
        // 模拟"响应丢失后原样重试同一账单"：seq 已前进到 1，重放 0 必败
        sub::charge_metered(&mut acct, &mut m, 7, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N1-3: 携带未来 seq → EBadChargeSeq（只接受恰好等于当前值）。
#[test, expected_failure(abort_code = EBadChargeSeq, location = isub::subscription)]
fun n1_3_metered_future_seq_aborts() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 7, 5, &clock, ts::ctx(&mut s)); // 当前 seq=0
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N1-4: 旧 charge 入口对 PAYG mandate → EBadMode（计量扣款必须走带 seq 的入口）。
#[test, expected_failure(abort_code = EBadMode, location = isub::subscription)]
fun n1_4_charge_on_payg_aborts() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_payg(&mut s, 100, 50, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort EBadMode
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N1-5: charge_metered 对 FIXED mandate → EBadMode。
#[test, expected_failure(abort_code = EBadMode, location = isub::subscription)]
fun n1_5_metered_on_fixed_aborts() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 10, 0, &clock, ts::ctx(&mut s)); // abort EBadMode
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N1-6: FIXED charge 也推进 charge_seq（链上"扣款笔数"，链下日志对账锚点）。
#[test]
fun n1_6_fixed_charge_advances_seq() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        assert!(sub::mandate_charge_seq(&m) == 0, 0);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_charge_seq(&m) == 1, 1);
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N2-1 ★核心: 商家部分退款 → 资金回 Account；refunded_total 记账；spent/预算不回冲。
#[test]
fun n2_1_refund_returns_funds() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // 先扣一笔 10
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // 商家退 4
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let c = coin::mint_for_testing<TEST_USD>(4, ts::ctx(&mut s));
        sub::refund(&mut acct, &mut m, c, ts::ctx(&mut s));
        assert!(sub::account_balance(&acct) == 94, 0);          // 90 + 4
        assert!(sub::mandate_refunded_total(&m) == 4, 1);
        assert!(sub::mandate_spent(&m) == 10, 2);               // 毛额不回冲
        assert!(sub::mandate_charge_seq(&m) == 1, 3);           // 退款不动扣款序号
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N2-2: 累计退款超过累计扣款 → ERefundExceedsSpent。
#[test, expected_failure(abort_code = ERefundExceedsSpent, location = isub::subscription)]
fun n2_2_refund_exceeds_spent_aborts() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let c = coin::mint_for_testing<TEST_USD>(11, ts::ctx(&mut s)); // > 已扣 10
        sub::refund(&mut acct, &mut m, c, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N2-3: 非商家退款 → ENotMerchant（资金路径只认 merchant 本人）。
#[test, expected_failure(abort_code = ENotMerchant, location = isub::subscription)]
fun n2_3_refund_not_merchant_aborts() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, ATTACKER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let c = coin::mint_for_testing<TEST_USD>(5, ts::ctx(&mut s));
        sub::refund(&mut acct, &mut m, c, ts::ctx(&mut s)); // abort ENotMerchant
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N2-4: revoke 后照样可退（用户取消后退最后一笔是常态）。
#[test]
fun n2_4_refund_after_revoke_ok() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    // USER 取消
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::revoke(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    // 商家全额退最后一笔
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let c = coin::mint_for_testing<TEST_USD>(10, ts::ctx(&mut s));
        sub::refund(&mut acct, &mut m, c, ts::ctx(&mut s));
        assert!(sub::account_balance(&acct) == 100, 0);         // 90 + 10
        assert!(sub::mandate_refunded_total(&m) == 10, 1);
        assert!(sub::mandate_status(&m) == sub::status_revoked(), 2); // 状态不变
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N2-5: 退入与 mandate 不匹配的 Account → EAccountMismatch（钱必须回到原账户）。
#[test, expected_failure(abort_code = EAccountMismatch, location = isub::subscription)]
fun n2_5_refund_wrong_account_aborts() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // ATTACKER 开第二个账户（与 mandate.account_id 不同）
    ts::next_tx(&mut s, ATTACKER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let mandate_acct = sub::mandate_account_id(&m);
        let mut a1 = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut a2 = ts::take_shared<Account<TEST_USD>>(&mut s);
        let c = coin::mint_for_testing<TEST_USD>(5, ts::ctx(&mut s));
        // 挑不匹配的那个账户退款 → abort
        if (object::id(&a1) == mandate_acct) {
            sub::refund(&mut a2, &mut m, c, ts::ctx(&mut s));
        } else {
            sub::refund(&mut a1, &mut m, c, ts::ctx(&mut s));
        };
        ts::return_shared(a1);
        ts::return_shared(a2);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// N2-6: 零额退款 → EWrongAmount（输入校验，F-02 惯例）。
#[test, expected_failure(abort_code = EWrongAmount, location = isub::subscription)]
fun n2_6_refund_zero_aborts() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        let c = coin::mint_for_testing<TEST_USD>(0, ts::ctx(&mut s));
        sub::refund(&mut acct, &mut m, c, ts::ctx(&mut s)); // abort EWrongAmount
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// =====================================================================
// Phase 4 — H-1：条款绑定 + 用户侧限额 + 首扣窗
//   防 UI 谎报/掉包（条款回声断言）、给用户独立于商家的单笔节流阀、可设首扣延迟。
// =====================================================================

// 内联建场：USER 开户+充值，MERCHANT 建指定模式 plan。返回后 Account/Plan 为 shared。
fun h1_open_deposit(s: &mut Scenario, deposit: u64) {
    ts::next_tx(s, USER);
    sub::open_account<TEST_USD>(ts::ctx(s));
    ts::next_tx(s, USER);
    deposit_amount(s, deposit);
}

// H1-1 ★: authorize_fixed 携带与 Plan 不符的 price → ETermsMismatch（UI 谎报/掉包防线）。
#[test, expected_failure(abort_code = ETermsMismatch, location = isub::subscription)]
fun h1_1_fixed_terms_mismatch() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s)); // 实际 price=10
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        // 用户以为 price=5（被商家 UI 欺骗）→ 断言失败，mandate 根本不生成
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 5, INTERVAL, MERCHANT, 1000, EXPIRY, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-2: authorize_metered 携带与 Plan 不符的 rate_cap → ETermsMismatch。
#[test, expected_failure(abort_code = ETermsMismatch, location = isub::subscription)]
fun h1_2_metered_terms_mismatch() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, RATE_WINDOW, KEEPER, ts::ctx(&mut s)); // 实际 cap=50
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_metered<TEST_USD>(&acct, &plan, 999, RATE_WINDOW, MERCHANT, KEEPER, 1000, EXPIRY, 10, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-3: authorize_fixed 用在 PAYG plan 上 → EBadMode（函数名即模式声明）。
#[test, expected_failure(abort_code = EBadMode, location = isub::subscription)]
fun h1_3_authorize_fixed_on_payg() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, RATE_WINDOW, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 0, 0, MERCHANT, 1000, EXPIRY, 0, &clock, ts::ctx(&mut s)); // abort EBadMode
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-4: authorize_metered 用在 Fixed plan 上 → EBadMode。
#[test, expected_failure(abort_code = EBadMode, location = isub::subscription)]
fun h1_4_authorize_metered_on_fixed() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_metered<TEST_USD>(&acct, &plan, 0, 0, MERCHANT, KEEPER, 1000, EXPIRY, 10, 0, &clock, ts::ctx(&mut s)); // abort EBadMode
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-5: PAYG max_per_charge=0 → EZeroMaxPerCharge。
#[test, expected_failure(abort_code = EZeroMaxPerCharge, location = isub::subscription)]
fun h1_5_metered_zero_max_per_charge() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, RATE_WINDOW, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_metered<TEST_USD>(&acct, &plan, 50, RATE_WINDOW, MERCHANT, KEEPER, 1000, EXPIRY, 0, 0, &clock, ts::ctx(&mut s)); // max=0 abort
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-6 ★: 单笔超过用户自设 max_per_charge → EOverMaxPerCharge（独立于商家 rate_cap 的用户节流阀）。
#[test, expected_failure(abort_code = EOverMaxPerCharge, location = isub::subscription)]
fun h1_6_over_max_per_charge() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, RATE_WINDOW, KEEPER, ts::ctx(&mut s)); // 商家 cap=50
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        // 用户自设单笔上限 10（远小于商家 cap 50）
        sub::authorize_metered<TEST_USD>(&acct, &plan, 50, RATE_WINDOW, MERCHANT, KEEPER, 1000, EXPIRY, 10, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    // 商家试图一笔扣 20（≤cap 50，但 >用户 max 10）→ EOverMaxPerCharge
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge_metered(&mut acct, &mut m, 20, 0, &clock, ts::ctx(&mut s)); // abort #24
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-7 ★: 首扣窗（first_charge_after）内扣款 → EIntervalNotElapsed（#6）。
#[test, expected_failure(abort_code = EIntervalNotElapsed, location = isub::subscription)]
fun h1_7_first_charge_after_blocks() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        // 首扣延迟 3 个 interval → not_before = 3000
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 10, INTERVAL, MERCHANT, 1000, EXPIRY, INTERVAL * 3, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    // 推进 1 个 interval（now=1000，仍在 not_before=3000 之前）
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s)); // abort #6（not_before 闸）
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-8: 首扣窗结束后扣款成功，且窗内被推迟的周期不追扣（只扣一笔）。
#[test]
fun h1_8_first_charge_after_then_ok() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 10, INTERVAL, MERCHANT, 100, EXPIRY, INTERVAL * 3, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    // 推进到 not_before（now = 3*INTERVAL）
    clock::increment_for_testing(&mut clock, INTERVAL * 3);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_spent(&m) == 10, 0);            // 只扣一笔，未追扣推迟的 3 期
        assert!(sub::account_balance(&acct) == 90, 1);
        assert!(sub::mandate_not_before(&m) == INTERVAL * 3, 2);
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-9: first_charge_after 把 not_before 推到 >= expiry → EBadExpiry（生而不可用，提前拦）。
#[test, expected_failure(abort_code = EBadExpiry, location = isub::subscription)]
fun h1_9_not_before_past_expiry() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        // first_charge_after = EXPIRY → not_before = EXPIRY，不满足 expiry > not_before
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 10, INTERVAL, MERCHANT, 1000, EXPIRY, EXPIRY, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// H1-10: Fixed 的 max_per_charge 自动 == price（用户无需设、且已被签名绑定）；默认无首扣延迟。
#[test]
fun h1_10_fixed_max_equals_price() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    setup_fixed(&mut s, 100, 10, 1000, &clock);
    ts::next_tx(&mut s, USER);
    {
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        assert!(sub::mandate_max_per_charge(&m) == 10, 0);   // == price
        assert!(sub::mandate_not_before(&m) == 0, 1);        // first_charge_after = 0
        ts::return_shared(m);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// =====================================================================
// Phase 5 — M-2：deactivate_plan（商家可下线套餐；消除 active 死代码）
// =====================================================================

// M2-1 ★: 下线后新 authorize → EPlanInactive（#11 现在可达，不再是死代码）。
#[test, expected_failure(abort_code = EPlanInactive, location = isub::subscription)]
fun m2_1_deactivate_blocks_new_authorize() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    // 商家下线套餐
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::deactivate_plan(&mut plan, ts::ctx(&mut s));
        assert!(!sub::plan_active(&plan), 0);
        ts::return_shared(plan);
    };
    // 用户对已下线 plan 授权 → EPlanInactive
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 10, INTERVAL, MERCHANT, 1000, EXPIRY, 0, &clock, ts::ctx(&mut s)); // abort
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// M2-2: 非商家下线 → ENotPlanMerchant。
#[test, expected_failure(abort_code = ENotPlanMerchant, location = isub::subscription)]
fun m2_2_deactivate_not_merchant() {
    let mut s = ts::begin(MERCHANT);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, ATTACKER);
    {
        let mut plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::deactivate_plan(&mut plan, ts::ctx(&mut s)); // abort ENotPlanMerchant
        ts::return_shared(plan);
    };
    ts::end(s);
}

// M2-3: 下线只挡新授权；存量 mandate 已快照条款、照常可扣。
#[test]
fun m2_3_existing_mandate_unaffected() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);
    setup_fixed(&mut s, 100, 10, 1000, &clock); // 已 authorize 一个 mandate
    // 商家事后下线套餐
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::deactivate_plan(&mut plan, ts::ctx(&mut s));
        assert!(!sub::plan_active(&plan), 0);
        ts::return_shared(plan);
    };
    // 存量 mandate 仍可扣（快照原则，不读 plan.active）
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_spent(&m) == 10, 1);
        ts::return_shared(acct);
        ts::return_shared(m);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// =====================================================================
// Phase 4 — 生产化：版本门 + 对象回收（close_*）
// =====================================================================

// V-1: 新建对象皆为当前版本；变更入口照常工作（版本门不挡正常路径）。
#[test]
fun v1_objects_at_current_version() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        assert!(sub::account_version(&acct) == sub::version(), 0);
        assert!(sub::mandate_version(&m) == sub::version(), 1);
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// V-2: 已是当前版本的对象再 migrate → EWrongVersion（单向，幂等安全）。
#[test, expected_failure(abort_code = EWrongVersion, location = isub::subscription)]
fun v2_migrate_current_aborts() {
    let mut s = ts::begin(USER);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        sub::migrate_account(&mut acct); // 已是 VERSION → abort
        ts::return_shared(acct);
    };

    ts::end(s);
}

// C-1 ★: 撤销后 close_mandate → 对象删除（存储押金退还）。
#[test]
fun c1_close_revoked_mandate() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    // USER 撤销
    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::revoke(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    // USER close（取走共享对象 by value 并删除）
    ts::next_tx(&mut s, USER);
    {
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::close_mandate(m, ts::ctx(&mut s));
    };
    // 对象已不存在
    ts::next_tx(&mut s, USER);
    assert!(!ts::has_most_recent_shared<Mandate<TEST_USD>>(), 0);

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// C-2: close_mandate 在未撤销（Active）时 → EMandateNotRevoked（防误删活跃授权）。
#[test, expected_failure(abort_code = EMandateNotRevoked, location = isub::subscription)]
fun c2_close_active_mandate_aborts() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, USER);
    {
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::close_mandate(m, ts::ctx(&mut s)); // 仍 Active → abort
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// C-3: close_mandate 由非 subscriber → ENotSubscriber。
#[test, expected_failure(abort_code = ENotSubscriber, location = isub::subscription)]
fun c3_close_mandate_not_subscriber() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, USER);
    {
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::revoke(&mut m, ts::ctx(&mut s));
        ts::return_shared(m);
    };
    ts::next_tx(&mut s, ATTACKER);
    {
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::close_mandate(m, ts::ctx(&mut s)); // 非 subscriber → abort
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// C-4 ★: 取空后 close_account → 删除。
#[test]
fun c4_close_empty_account() {
    let mut s = ts::begin(USER);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    deposit_amount(&mut s, 100);
    // 取空
    ts::next_tx(&mut s, USER);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let out = sub::withdraw_all(&mut acct, ts::ctx(&mut s));
        transfer::public_transfer(out, USER);
        ts::return_shared(acct);
    };
    // close
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        sub::close_account(acct, ts::ctx(&mut s));
    };
    ts::next_tx(&mut s, USER);
    assert!(!ts::has_most_recent_shared<Account<TEST_USD>>(), 0);

    ts::end(s);
}

// C-5: 余额非零时 close_account → EAccountNotEmpty（先取空才能回收）。
#[test, expected_failure(abort_code = EAccountNotEmpty, location = isub::subscription)]
fun c5_close_nonempty_account_aborts() {
    let mut s = ts::begin(USER);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    deposit_amount(&mut s, 100);
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        sub::close_account(acct, ts::ctx(&mut s)); // 余额 100 → abort
    };

    ts::end(s);
}

// C-6: close_account 由非 owner → ENotOwner。
#[test, expected_failure(abort_code = ENotOwner, location = isub::subscription)]
fun c6_close_account_not_owner() {
    let mut s = ts::begin(USER);

    ts::next_tx(&mut s, USER);
    sub::open_account<TEST_USD>(ts::ctx(&mut s));
    ts::next_tx(&mut s, ATTACKER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        sub::close_account(acct, ts::ctx(&mut s)); // 非 owner → abort
    };

    ts::end(s);
}

// C-7: close_plan（merchant）→ 删除；存量 mandate 不受影响（已快照）。
#[test]
fun c7_close_plan() {
    let mut s = ts::begin(USER);
    let mut clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, MERCHANT);
    {
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::close_plan(plan, ts::ctx(&mut s));
    };
    ts::next_tx(&mut s, MERCHANT);
    assert!(!ts::has_most_recent_shared<Plan<TEST_USD>>(), 0);
    // 存量 mandate 仍可扣
    clock::increment_for_testing(&mut clock, INTERVAL);
    ts::next_tx(&mut s, MERCHANT);
    {
        let mut acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let mut m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        sub::charge(&mut acct, &mut m, 10, &clock, ts::ctx(&mut s));
        assert!(sub::mandate_spent(&m) == 10, 0);
        ts::return_shared(acct);
        ts::return_shared(m);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// C-8: close_plan 由非 merchant → ENotPlanMerchant。
#[test, expected_failure(abort_code = ENotPlanMerchant, location = isub::subscription)]
fun c8_close_plan_not_merchant() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);

    setup_fixed(&mut s, 100, 10, 1000, &clock);

    ts::next_tx(&mut s, ATTACKER);
    {
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::close_plan(plan, ts::ctx(&mut s)); // 非 merchant → abort
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

// =====================================================================
// Phase 6 — R-1 / M-3：把 merchant / keeper 也绑进 authorize 签名
//   补完 F-05 terms-binding：同价/同周期的 plan 掉包不能再重定向收款人;keeper 显式审批。
// =====================================================================

// R1-1 ★: authorize_fixed 携带错误 expected_merchant（plan 掉包换收款人）→ ETermsMismatch。
#[test, expected_failure(abort_code = ETermsMismatch, location = isub::subscription)]
fun r1_1_fixed_merchant_mismatch() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_fixed<TEST_USD>(10, INTERVAL, KEEPER, ts::ctx(&mut s)); // merchant=MERCHANT
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        // 价格/周期都对,但收款人写成 ATTACKER(用户以为在订 MERCHANT)→ abort
        sub::authorize_fixed<TEST_USD>(&acct, &plan, 10, INTERVAL, ATTACKER, 1000, EXPIRY, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// R1-2: authorize_metered 携带错误 expected_merchant → ETermsMismatch。
#[test, expected_failure(abort_code = ETermsMismatch, location = isub::subscription)]
fun r1_2_metered_merchant_mismatch() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, RATE_WINDOW, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_metered<TEST_USD>(&acct, &plan, 50, RATE_WINDOW, ATTACKER, KEEPER, 1000, EXPIRY, 10, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// M3-1 ★: authorize_metered 携带错误 expected_keeper（用户现在显式审批 keeper）→ ETermsMismatch。
#[test, expected_failure(abort_code = ETermsMismatch, location = isub::subscription)]
fun m3_1_metered_keeper_mismatch() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, RATE_WINDOW, KEEPER, ts::ctx(&mut s)); // keeper=KEEPER
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        // merchant 对,但 keeper 写成 ATTACKER → abort(防商家偷塞任意 keeper)
        sub::authorize_metered<TEST_USD>(&acct, &plan, 50, RATE_WINDOW, MERCHANT, ATTACKER, 1000, EXPIRY, 10, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}

// R1-3: merchant + keeper 全对 → 成功（正向,证明绑定不误伤合法授权）。
#[test]
fun r1_3_correct_terms_ok() {
    let mut s = ts::begin(USER);
    let clock = new_clock(&mut s);
    h1_open_deposit(&mut s, 100);
    ts::next_tx(&mut s, MERCHANT);
    sub::create_plan_payg<TEST_USD>(50, RATE_WINDOW, KEEPER, ts::ctx(&mut s));
    ts::next_tx(&mut s, USER);
    {
        let acct = ts::take_shared<Account<TEST_USD>>(&mut s);
        let plan = ts::take_shared<Plan<TEST_USD>>(&mut s);
        sub::authorize_metered<TEST_USD>(&acct, &plan, 50, RATE_WINDOW, MERCHANT, KEEPER, 1000, EXPIRY, 10, 0, &clock, ts::ctx(&mut s));
        ts::return_shared(acct);
        ts::return_shared(plan);
    };
    ts::next_tx(&mut s, USER);
    {
        let m = ts::take_shared<Mandate<TEST_USD>>(&mut s);
        assert!(sub::mandate_status(&m) == sub::status_active(), 0);
        ts::return_shared(m);
    };
    clock::destroy_for_testing(clock);
    ts::end(s);
}
