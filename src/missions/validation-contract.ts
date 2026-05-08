import type { SharedState } from './shared-state.js';
import type { ValidationContract } from './missions.types.js';

export class ValidationContractManager {
  constructor(private sharedState: SharedState) {}

  write(contract: ValidationContract): void {
    this.sharedState.writeValidationContract(contract);
  }

  read(): ValidationContract | null {
    return this.sharedState.readValidationContract();
  }

  lock(): void {
    this.sharedState.lockValidationContract();
  }

  isLocked(): boolean {
    const contract = this.read();
    return contract?.locked ?? false;
  }
}
