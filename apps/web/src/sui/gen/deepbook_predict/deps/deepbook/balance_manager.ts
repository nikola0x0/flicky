/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct } from '../../../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import * as bag from '../sui/bag.js';
import * as vec_set from '../sui/vec_set.js';
const $moduleName = 'deepbook::balance_manager';
export const BalanceManager = new MoveStruct({ name: `${$moduleName}::BalanceManager`, fields: {
        id: bcs.Address,
        owner: bcs.Address,
        balances: bag.Bag,
        allow_listed: vec_set.VecSet(bcs.Address)
    } });
export const DepositCap = new MoveStruct({ name: `${$moduleName}::DepositCap`, fields: {
        id: bcs.Address,
        balance_manager_id: bcs.Address
    } });
export const WithdrawCap = new MoveStruct({ name: `${$moduleName}::WithdrawCap`, fields: {
        id: bcs.Address,
        balance_manager_id: bcs.Address
    } });