/// iSub — 非托管的周期/计量"拉取"支付原语。Account + Mandate 模型。
///
/// 设计取舍（用户硬约束："不预储值 + 随时取消"）：
///   - 资金待在用户**自己的可复用 Account**（随时全额取回，多订阅共用，不按订阅锁定）。
///   - 商家持有**有上限、可撤销的 Mandate**（授权），到期从 Account 拉取。
///   - `authorize` **不搬动任何资金** —— 授权一个商家 = 零预储值。
///   - 这是 Stripe"存档卡"在 Sui 上的等价物：卡=你的 Account，扣款授权=Mandate。
///
/// Sui 铁律：无 ERC20 approve、商家碰不到主钱包 owned 币 → 自动拉取要求资金待在
/// 一个共享对象里。Account 即此对象，但它是用户自己的、可随时取回的余额，非按订阅托管。
module isub::subscription;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::clock::Clock;
use sui::event;
use std::ascii;
// ALTERNATE: official Sui Payment Kit — the merchant payout routes through it (receipts).
use payment_kit::payment_kit;

// ===== 计费模式 =====
const MODE_FIXED: u8 = 0;
const MODE_PAYG: u8 = 1;

// ===== Mandate 状态 =====
const STATUS_ACTIVE: u8 = 0;
const STATUS_PAUSED: u8 = 1;
const STATUS_REVOKED: u8 = 2;

// ===== 错误码 =====
const ENotOwner: u64 = 1;             // 非 Account 所有者
const ENotSubscriber: u64 = 2;        // 非 Mandate 授权人
const ENotAuthorizedCharger: u64 = 3;
const ENotActive: u64 = 4;
const EExpired: u64 = 5;
const EIntervalNotElapsed: u64 = 6;
const EWrongAmount: u64 = 7;
const EOverRateCap: u64 = 8;
const EOverTotalBudget: u64 = 9;
const EInsufficientAccount: u64 = 10;
const EPlanInactive: u64 = 11;
const EBadMode: u64 = 12;
const EAccountMismatch: u64 = 13;
// 输入校验
const EZeroPrice: u64 = 14;
const EZeroInterval: u64 = 15;
const EZeroRateCap: u64 = 16;
const EZeroRateWindow: u64 = 17;
const EZeroBudget: u64 = 18;
const EBadExpiry: u64 = 19;
// 资金正确性强化（N-1 / N-2）
const EBadChargeSeq: u64 = 20;        // metered 扣款序号 ≠ mandate 当前 charge_seq（幂等闸）
const ERefundExceedsSpent: u64 = 21;  // 累计退款超过累计扣款
const ENotMerchant: u64 = 22;         // 非本 mandate 的商家
// H-1 整改（条款绑定签名 + 用户侧节流）
const ETermsMismatch: u64 = 23;       // authorize 携带的预期条款 ≠ Plan 实际条款（防 UI 谎报/掉包）
const EOverMaxPerCharge: u64 = 24;    // 单笔超过用户设定的 max_per_charge
const EZeroMaxPerCharge: u64 = 25;    // max_per_charge 不能为 0
const ENotPlanMerchant: u64 = 26;     // 非本 Plan 的商家（deactivate_plan）
// 生产化：版本门 + 对象回收
const EWrongVersion: u64 = 27;        // 对象版本 ≠ 当前包版本（需先 migrate）
const EAccountNotEmpty: u64 = 28;     // close_account 时余额非零
const EMandateNotRevoked: u64 = 29;   // close_mandate 要求 mandate 已撤销（终态）

// ===== 版本门（升级安全）=====
//
// Sui 包升级**不能改已有结构体字段布局** → 共享对象的字段在主网上线即冻结。
// 每个对象带 `version`，所有变更入口断言 == 当前包 `VERSION`：升级后存量对象被新代码
// 拒绝，直到 migrate。migrate 为 permissionless 单向（真正的升级权在 UpgradeCap，已是
// 信任点；保持本原语"无中心 admin"的承诺）。VERSION 在主网前可随结构演进自由保持 1。
const VERSION: u64 = 1;

fun check_account_version<T>(a: &Account<T>) { assert!(a.version == VERSION, EWrongVersion); }
fun check_plan_version<T>(p: &Plan<T>) { assert!(p.version == VERSION, EWrongVersion); }
fun check_mandate_version<T>(m: &Mandate<T>) { assert!(m.version == VERSION, EWrongVersion); }

// ===== 对象 =====

/// 用户的可复用支付账户。**共享对象**（Mandate 需无用户签名即可拉取）；
/// 所有者随时 deposit/withdraw。资金在此，但属用户、可随时取回，非按订阅托管。
public struct Account<phantom T> has key {
    id: UID,
    version: u64,
    owner: address,
    balance: Balance<T>,
}

/// 商家套餐（共享，可读）。
public struct Plan<phantom T> has key {
    id: UID,
    version: u64,
    merchant: address,
    mode: u8,
    price: u64,
    interval_ms: u64,
    rate_cap: u64,
    rate_window_ms: u64,
    keeper: address,
    active: bool,
}

/// 有上限、可撤销的授权：商家可在限额内从 `account_id` 拉取。**不持有资金**。
/// 共享对象，商家/keeper 无需用户签名即可 charge。
public struct Mandate<phantom T> has key {
    id: UID,
    version: u64,
    account_id: ID,
    subscriber: address,
    merchant: address,
    plan_id: ID,
    mode: u8,
    // Fixed
    price: u64,
    interval_ms: u64,
    last_charged_ms: u64,
    // PAYG
    rate_cap: u64,
    rate_window_ms: u64,
    window_start_ms: u64,
    window_spent: u64,
    authorized_keeper: address,
    // 共用上限
    spent_total: u64,
    total_budget: u64,
    expiry_ms: u64,
    // 计费序号：每次成功扣款 +1。metered 扣款必须携带当前值（N-1 幂等闸）；
    // 同时充当链上"扣款笔数"，供链下日志对账。
    charge_seq: u64,
    // 累计退款（商家退回 Account）。不回冲 spent_total —— 预算按毛额单调消耗，
    // 防 charge↔refund 往返把额度洗复活；净支出 = spent_total - refunded_total。
    refunded_total: u64,
    // H-1：用户侧节流（authorize 时由用户签定，独立于商家条款）。
    // 单笔上限：Fixed 恒 = price（amount==price 已钉死单笔）；PAYG = 用户独立设定。
    max_per_charge: u64,
    // 首扣不早于（= authorize 时刻 + 用户设定的延迟；延迟 0 = 立即可扣，现行为）。
    not_before_ms: u64,
    status: u8,
}

// ===== 事件 =====
public struct AccountOpened has copy, drop { account_id: ID, owner: address }
public struct Deposited has copy, drop { account_id: ID, amount: u64 }
public struct AccountWithdrawn has copy, drop { account_id: ID, amount: u64 }
public struct PlanCreated has copy, drop { plan_id: ID, merchant: address, mode: u8 }
public struct PlanDeactivated has copy, drop { plan_id: ID }
public struct MandateAuthorized has copy, drop { mandate_id: ID, account_id: ID, subscriber: address, merchant: address }
public struct Charged has copy, drop { mandate_id: ID, account_id: ID, amount: u64, spent_total: u64, seq: u64, by: address }
public struct Refunded has copy, drop { mandate_id: ID, account_id: ID, amount: u64, refunded_total: u64 }
public struct MandateRevoked has copy, drop { mandate_id: ID }
public struct AccountClosed has copy, drop { account_id: ID }
public struct MandateClosed has copy, drop { mandate_id: ID }
public struct PlanClosed has copy, drop { plan_id: ID }

// ===== Account（用户的可复用余额）=====

public fun open_account<T>(ctx: &mut TxContext) {
    let acct = Account<T> { id: object::new(ctx), version: VERSION, owner: ctx.sender(), balance: balance::zero<T>() };
    event::emit(AccountOpened { account_id: object::id(&acct), owner: acct.owner });
    transfer::share_object(acct);
}

/// 任何人可充值（只增加所有者可取回的余额）。
public fun deposit<T>(account: &mut Account<T>, coin: Coin<T>) {
    check_account_version(account);
    let amt = coin::value(&coin);
    balance::join(&mut account.balance, coin::into_balance(coin));
    event::emit(Deposited { account_id: object::id(account), amount: amt });
}

/// 所有者随时取回任意金额（非托管退出权）。
public fun withdraw<T>(account: &mut Account<T>, amount: u64, ctx: &mut TxContext): Coin<T> {
    check_account_version(account);
    assert!(ctx.sender() == account.owner, ENotOwner);
    let out = coin::from_balance(balance::split(&mut account.balance, amount), ctx);
    event::emit(AccountWithdrawn { account_id: object::id(account), amount });
    out
}

/// 所有者一次取回全部。
public fun withdraw_all<T>(account: &mut Account<T>, ctx: &mut TxContext): Coin<T> {
    check_account_version(account);
    assert!(ctx.sender() == account.owner, ENotOwner);
    let amt = balance::value(&account.balance);
    let out = coin::from_balance(balance::withdraw_all(&mut account.balance), ctx);
    event::emit(AccountWithdrawn { account_id: object::id(account), amount: amt });
    out
}

// ===== 商家套餐 =====

public fun create_plan_fixed<T>(price: u64, interval_ms: u64, keeper: address, ctx: &mut TxContext) {
    assert!(price > 0, EZeroPrice);
    assert!(interval_ms > 0, EZeroInterval);
    let plan = Plan<T> { id: object::new(ctx), version: VERSION, merchant: ctx.sender(), mode: MODE_FIXED,
        price, interval_ms, rate_cap: 0, rate_window_ms: 0, keeper, active: true };
    event::emit(PlanCreated { plan_id: object::id(&plan), merchant: plan.merchant, mode: MODE_FIXED });
    transfer::share_object(plan);
}

public fun create_plan_payg<T>(rate_cap: u64, rate_window_ms: u64, keeper: address, ctx: &mut TxContext) {
    assert!(rate_cap > 0, EZeroRateCap);
    assert!(rate_window_ms > 0, EZeroRateWindow);
    let plan = Plan<T> { id: object::new(ctx), version: VERSION, merchant: ctx.sender(), mode: MODE_PAYG,
        price: 0, interval_ms: 0, rate_cap, rate_window_ms, keeper, active: true };
    event::emit(PlanCreated { plan_id: object::id(&plan), merchant: plan.merchant, mode: MODE_PAYG });
    transfer::share_object(plan);
}

/// 商家下线套餐（单向，merchant-only）：只挡**新** `authorize`；存量 Mandate 已快照条款、不受影响。
public fun deactivate_plan<T>(plan: &mut Plan<T>, ctx: &TxContext) {
    check_plan_version(plan);
    assert!(ctx.sender() == plan.merchant, ENotPlanMerchant);
    plan.active = false;
    event::emit(PlanDeactivated { plan_id: object::id(plan) });
}

// ===== 授权（用户给商家发 Mandate —— 不搬动任何资金）=====
//
// H-1 整改：按模式拆双入口，签名携带"条款回声"。
//   - 用户的签名密码学地绑定到一组具体条款（expected_* 断言 == Plan）——
//     UI 谎报/掉包 plan ⇒ ETermsMismatch，mandate 根本不生成。函数名绑定模式本身。
//   - expected_* 必须来自用户亲眼所见的报价（中立 widget / 钱包 Display），
//     SDK 不得从被授权的同一个 Plan 自动回填，否则断言形同虚设。
//   - 参数序 = 同意叙事：对象 → 条款回声 → 总界限（budget/expiry）→ 节流阀。

public fun authorize_fixed<T>(
    account: &Account<T>,
    plan: &Plan<T>,
    expected_price: u64,
    expected_interval_ms: u64,
    expected_merchant: address,
    total_budget: u64,
    expiry_ms: u64,
    first_charge_after_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    check_account_version(account);
    check_plan_version(plan);
    assert!(plan.mode == MODE_FIXED, EBadMode);
    // R-1：把 merchant（收款人）也绑进签名 —— 否则同价/同周期的 plan 掉包能把钱重定向到攻击者，
    // terms-binding 的"防掉包"承诺只兑现了一半。keeper 不绑：Fixed charge permissionless，对其无访问控制意义。
    assert!(
        plan.price == expected_price
            && plan.interval_ms == expected_interval_ms
            && plan.merchant == expected_merchant,
        ETermsMismatch,
    );
    // Fixed 的单笔上限就是 price（amount==price 已钉死），且已被签名绑定。
    new_mandate(account, plan, total_budget, expiry_ms, plan.price, first_charge_after_ms, clock, ctx);
}

public fun authorize_metered<T>(
    account: &Account<T>,
    plan: &Plan<T>,
    expected_rate_cap: u64,
    expected_rate_window_ms: u64,
    expected_merchant: address,
    expected_keeper: address,
    total_budget: u64,
    expiry_ms: u64,
    max_per_charge: u64,
    first_charge_after_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    check_account_version(account);
    check_plan_version(plan);
    assert!(plan.mode == MODE_PAYG, EBadMode);
    // R-1 + M-3：除速率条款外，把 merchant（收款人）与 keeper（PAYG 的授权扣款方）一起绑进签名 ——
    // 这两个 address 是用户最该确认的条款；不绑则 plan 掉包能换收款人，且 keeper 由用户隐式信任。
    assert!(
        plan.rate_cap == expected_rate_cap
            && plan.rate_window_ms == expected_rate_window_ms
            && plan.merchant == expected_merchant
            && plan.keeper == expected_keeper,
        ETermsMismatch,
    );
    // 用户独立的单笔节流阀（不依赖商家定义的 rate_cap）—— 把"瞬间扣满预算"
    // 压成"有节奏扣款"，给 revoke/withdraw 争取反应时间。注意：它不降低
    // 总敞口天花板（仍 = total_budget），这点在 §7 文档里诚实声明。
    assert!(max_per_charge > 0, EZeroMaxPerCharge);
    new_mandate(account, plan, total_budget, expiry_ms, max_per_charge, first_charge_after_ms, clock, ctx);
}

/// 共用构造尾（模块私有）：owner/plan/budget/时间界校验 → 快照条款 → 共享。
fun new_mandate<T>(
    account: &Account<T>,
    plan: &Plan<T>,
    total_budget: u64,
    expiry_ms: u64,
    max_per_charge: u64,
    first_charge_after_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == account.owner, ENotOwner);
    assert!(plan.active, EPlanInactive);
    assert!(total_budget > 0, EZeroBudget);
    let now = clock.timestamp_ms();
    let not_before = now + first_charge_after_ms;
    // 到期必须晚于首个可扣时点（否则 mandate 生而不可用）。
    assert!(expiry_ms > not_before, EBadExpiry);
    // 首扣在 not_before 即到期（延迟 0 = Stripe 式立即首扣）。延迟后的节奏由
    // F-01（charge 时 last=now）自动锚定，无需额外数学。
    let last = if (plan.interval_ms <= now) { now - plan.interval_ms } else { 0 };
    let mandate = Mandate<T> {
        id: object::new(ctx),
        version: VERSION,
        account_id: object::id(account),
        subscriber: ctx.sender(),
        merchant: plan.merchant,
        plan_id: object::id(plan),
        mode: plan.mode,
        price: plan.price,
        interval_ms: plan.interval_ms,
        last_charged_ms: last,
        rate_cap: plan.rate_cap,
        rate_window_ms: plan.rate_window_ms,
        window_start_ms: now,
        window_spent: 0,
        authorized_keeper: plan.keeper,
        spent_total: 0,
        total_budget,
        expiry_ms,
        charge_seq: 0,
        refunded_total: 0,
        max_per_charge,
        not_before_ms: not_before,
        status: STATUS_ACTIVE,
    };
    event::emit(MandateAuthorized {
        mandate_id: object::id(&mandate), account_id: mandate.account_id,
        subscriber: mandate.subscriber, merchant: mandate.merchant,
    });
    transfer::share_object(mandate);
}

// ===== charge（在 mandate 限额内从 account 拉取）=====
//
// 拆成两个入口（N-1）：
//   - `charge`：仅 FIXED。permissionless —— 金额被 price 钉死、时点被 interval 闸死，
//     重试天然幂等（第二次必撞 EIntervalNotElapsed）。
//   - `charge_metered`：仅 PAYG。金额由商家链下计量决定 → 限 merchant/keeper，且必须
//     携带幂等序号 `seq`==当前 charge_seq：账单超时重试要么撞上序号已前进（EBadChargeSeq）
//     要么正常落账 —— 同一账单不可能扣两次。
// 公共闸（账户匹配/状态/到期）+ 结算尾（预算/余额/打款/事件）在 `settle` 统一出口。

public fun charge<T>(account: &mut Account<T>, mandate: &mut Mandate<T>, amount: u64, clock: &Clock, ctx: &mut TxContext) {
    check_account_version(account);
    check_mandate_version(mandate);
    assert!(mandate.account_id == object::id(account), EAccountMismatch);
    assert!(mandate.status == STATUS_ACTIVE, ENotActive);
    let now = clock.timestamp_ms();
    assert!(now < mandate.expiry_ms, EExpired);
    // H-1：用户自设的首扣窗（"还没到时候"，与 interval 闸同语义 → 复用 #6）。
    assert!(now >= mandate.not_before_ms, EIntervalNotElapsed);
    assert!(mandate.mode == MODE_FIXED, EBadMode);

    assert!(amount == mandate.price, EWrongAmount);
    assert!(now >= mandate.last_charged_ms + mandate.interval_ms, EIntervalNotElapsed);
    // F-01 修复：置 now（非 += interval），防单笔 PTB 累积抽干。
    mandate.last_charged_ms = now;

    settle(account, mandate, amount, clock, ctx);
}

public fun charge_metered<T>(
    account: &mut Account<T>,
    mandate: &mut Mandate<T>,
    amount: u64,
    seq: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    check_account_version(account);
    check_mandate_version(mandate);
    assert!(mandate.account_id == object::id(account), EAccountMismatch);
    assert!(mandate.status == STATUS_ACTIVE, ENotActive);
    let now = clock.timestamp_ms();
    assert!(now < mandate.expiry_ms, EExpired);
    // H-1：用户自设的首扣窗（同 charge，复用 #6）。
    assert!(now >= mandate.not_before_ms, EIntervalNotElapsed);
    assert!(mandate.mode == MODE_PAYG, EBadMode);
    let caller = ctx.sender();
    assert!(caller == mandate.merchant || caller == mandate.authorized_keeper, ENotAuthorizedCharger);
    assert!(seq == mandate.charge_seq, EBadChargeSeq);
    
    if (now >= mandate.window_start_ms + mandate.rate_window_ms) {
        mandate.window_start_ms = now;
        mandate.window_spent = 0;
    };
    assert!(mandate.window_spent + amount <= mandate.rate_cap, EOverRateCap);
    mandate.window_spent = mandate.window_spent + amount;

    settle(account, mandate, amount, clock, ctx);
}

/// 结算尾（两种模式共用、模块私有）：预算/余额闸 → 记账 → 序号 +1 → 打款商家 → 事件。
/// 资金守恒逻辑的唯一出口。
fun settle<T>(account: &mut Account<T>, mandate: &mut Mandate<T>, amount: u64, clock: &Clock, ctx: &mut TxContext) {
    // H-1：用户侧单笔节流阀（Fixed 恒真 = price；PAYG 用户独立设定）。
    assert!(amount <= mandate.max_per_charge, EOverMaxPerCharge);
    assert!(mandate.spent_total + amount <= mandate.total_budget, EOverTotalBudget);
    assert!(balance::value(&account.balance) >= amount, EInsufficientAccount);
    mandate.spent_total = mandate.spent_total + amount;
    mandate.charge_seq = mandate.charge_seq + 1;
    let paid = coin::from_balance(balance::split(&mut account.balance, amount), ctx);
    // ALTERNATE: route the merchant payout through the official Sui Payment Kit.
    // `process_ephemeral_payment` transfers `paid` to the merchant and emits an on-chain
    // PaymentReceipt event; the receipt (copy+drop) is discarded. Our own `Charged` event
    // is still emitted, so SDK / keeper semantics are byte-for-byte unchanged.
    let _receipt = payment_kit::process_ephemeral_payment(
        ascii::string(b"isub-charge"),
        amount,
        paid,
        mandate.merchant,
        clock,
        ctx,
    );
    event::emit(Charged {
        mandate_id: object::id(mandate), account_id: mandate.account_id,
        amount, spent_total: mandate.spent_total, seq: mandate.charge_seq, by: ctx.sender(),
    });
}

// ===== refund（N-2：商家退款 → 回到订阅者的 Account）=====

/// 商家把已扣款项（部分或全部）退回该 mandate 绑定的 Account。
/// - 仅 merchant 可调；退入 Account（非钱包）—— 资金留在体系内、用户随时可取回。
/// - 不回冲 spent_total/预算（毛额单调）；refunded_total 单独记账，净支出可链下推导。
/// - 不检查 status/expiry：撤销/过期后照样可退（用户取消后退最后一笔是常态）。
public fun refund<T>(account: &mut Account<T>, mandate: &mut Mandate<T>, coin: Coin<T>, ctx: &TxContext) {
    check_account_version(account);
    check_mandate_version(mandate);
    assert!(mandate.account_id == object::id(account), EAccountMismatch);
    assert!(ctx.sender() == mandate.merchant, ENotMerchant);
    let amt = coin::value(&coin);
    assert!(amt > 0, EWrongAmount);
    assert!(mandate.refunded_total + amt <= mandate.spent_total, ERefundExceedsSpent);
    mandate.refunded_total = mandate.refunded_total + amt;
    balance::join(&mut account.balance, coin::into_balance(coin));
    event::emit(Refunded {
        mandate_id: object::id(mandate), account_id: mandate.account_id,
        amount: amt, refunded_total: mandate.refunded_total,
    });
}

// ===== 用户控制（随时取消）=====

/// 撤销授权 —— 即"取消订阅"。此后该商家不可再扣。终态。
public fun revoke<T>(mandate: &mut Mandate<T>, ctx: &TxContext) {
    check_mandate_version(mandate);
    assert!(ctx.sender() == mandate.subscriber, ENotSubscriber);
    mandate.status = STATUS_REVOKED;
    event::emit(MandateRevoked { mandate_id: object::id(mandate) });
}

public fun pause<T>(mandate: &mut Mandate<T>, ctx: &TxContext) {
    check_mandate_version(mandate);
    assert!(ctx.sender() == mandate.subscriber, ENotSubscriber);
    assert!(mandate.status == STATUS_ACTIVE, ENotActive);
    mandate.status = STATUS_PAUSED;
}

public fun resume<T>(mandate: &mut Mandate<T>, clock: &Clock, ctx: &TxContext) {
    check_mandate_version(mandate);
    assert!(ctx.sender() == mandate.subscriber, ENotSubscriber);
    assert!(mandate.status == STATUS_PAUSED, ENotActive);  // revoked 是终态，不可恢复
    // F-03 修复：暂停 = 豁免，不是延期。把计费游标拉到 now，避免恢复后追扣暂停期。
    let now = clock.timestamp_ms();
    mandate.last_charged_ms = now;     // FIXED：下次扣款是一个完整 interval 之后
    mandate.window_start_ms = now;     // PAYG：恢复后是干净的速率窗口
    mandate.window_spent = 0;
    mandate.status = STATUS_ACTIVE;
}

// ===== 对象回收（删除共享对象 → 退还存储押金，防状态膨胀）=====

/// owner 回收空 Account 的存储押金（必须先取空余额）。
public fun close_account<T>(account: Account<T>, ctx: &TxContext) {
    let Account { id, version: _, owner, balance } = account;
    assert!(ctx.sender() == owner, ENotOwner);
    assert!(balance::value(&balance) == 0, EAccountNotEmpty);
    balance::destroy_zero(balance);
    let aid = id.to_inner();
    id.delete();
    event::emit(AccountClosed { account_id: aid });
}

/// 订阅者回收已撤销 Mandate 的存储押金（要求终态，避免误删活跃授权）。
public fun close_mandate<T>(mandate: Mandate<T>, ctx: &TxContext) {
    assert!(ctx.sender() == mandate.subscriber, ENotSubscriber);
    assert!(mandate.status == STATUS_REVOKED, EMandateNotRevoked);
    let mid = object::id(&mandate);
    let Mandate { id, .. } = mandate;
    id.delete();
    event::emit(MandateClosed { mandate_id: mid });
}

/// 商家回收 Plan 的存储押金（存量 Mandate 已快照条款、不受影响）。
public fun close_plan<T>(plan: Plan<T>, ctx: &TxContext) {
    assert!(ctx.sender() == plan.merchant, ENotPlanMerchant);
    let pid = object::id(&plan);
    let Plan { id, .. } = plan;
    id.delete();
    event::emit(PlanClosed { plan_id: pid });
}

// ===== 版本迁移（升级后把存量对象搬进新代码；permissionless 单向）=====

public fun migrate_account<T>(account: &mut Account<T>) {
    assert!(account.version < VERSION, EWrongVersion);
    account.version = VERSION;
}
public fun migrate_plan<T>(plan: &mut Plan<T>) {
    assert!(plan.version < VERSION, EWrongVersion);
    plan.version = VERSION;
}
public fun migrate_mandate<T>(mandate: &mut Mandate<T>) {
    assert!(mandate.version < VERSION, EWrongVersion);
    mandate.version = VERSION;
}

// ===== 测试专用只读 getter（#[test_only]，生产模块零暴露）=====

#[test_only]
public fun account_balance<T>(account: &Account<T>): u64 {
    balance::value(&account.balance)
}

#[test_only]
public fun account_owner<T>(account: &Account<T>): address {
    account.owner
}

#[test_only]
public fun mandate_spent<T>(mandate: &Mandate<T>): u64 {
    mandate.spent_total
}

#[test_only]
public fun mandate_last_charged<T>(mandate: &Mandate<T>): u64 {
    mandate.last_charged_ms
}

#[test_only]
public fun mandate_status<T>(mandate: &Mandate<T>): u8 {
    mandate.status
}

#[test_only]
public fun mandate_window_spent<T>(mandate: &Mandate<T>): u64 {
    mandate.window_spent
}

#[test_only]
public fun mandate_window_start<T>(mandate: &Mandate<T>): u64 {
    mandate.window_start_ms
}

#[test_only]
public fun mandate_total_budget<T>(mandate: &Mandate<T>): u64 {
    mandate.total_budget
}

#[test_only]
public fun mandate_mode<T>(mandate: &Mandate<T>): u8 {
    mandate.mode
}

#[test_only]
public fun mandate_account_id<T>(mandate: &Mandate<T>): ID {
    mandate.account_id
}

#[test_only]
public fun mandate_merchant<T>(mandate: &Mandate<T>): address {
    mandate.merchant
}

#[test_only]
public fun mandate_price<T>(mandate: &Mandate<T>): u64 {
    mandate.price
}

#[test_only]
public fun mandate_charge_seq<T>(mandate: &Mandate<T>): u64 {
    mandate.charge_seq
}

#[test_only]
public fun mandate_refunded_total<T>(mandate: &Mandate<T>): u64 {
    mandate.refunded_total
}

#[test_only]
public fun mandate_max_per_charge<T>(mandate: &Mandate<T>): u64 {
    mandate.max_per_charge
}

#[test_only]
public fun mandate_not_before<T>(mandate: &Mandate<T>): u64 {
    mandate.not_before_ms
}

#[test_only]
public fun plan_price<T>(plan: &Plan<T>): u64 {
    plan.price
}

#[test_only]
public fun plan_interval<T>(plan: &Plan<T>): u64 {
    plan.interval_ms
}

#[test_only]
public fun plan_active<T>(plan: &Plan<T>): bool {
    plan.active
}

#[test_only]
public fun plan_merchant<T>(plan: &Plan<T>): address {
    plan.merchant
}

#[test_only]
public fun account_version<T>(account: &Account<T>): u64 {
    account.version
}

#[test_only]
public fun mandate_version<T>(mandate: &Mandate<T>): u64 {
    mandate.version
}

#[test_only]
public fun version(): u64 { VERSION }

// 测试用：暴露状态常量，便于断言（避免在测试模块里硬编码数字）
#[test_only]
public fun status_active(): u8 { STATUS_ACTIVE }

#[test_only]
public fun status_paused(): u8 { STATUS_PAUSED }

#[test_only]
public fun status_revoked(): u8 { STATUS_REVOKED }

#[test_only]
public fun mode_fixed(): u8 { MODE_FIXED }

#[test_only]
public fun mode_payg(): u8 { MODE_PAYG }
