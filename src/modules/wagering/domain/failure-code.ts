export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',  
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',  

  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletMismatch = 'WALLET_MISMATCH', 

  ReferenceNotFound = 'REFERENCE_NOT_FOUND',  
  ReferenceMismatch = 'REFERENCE_MISMATCH',  
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',  
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',  
  AlreadyReversed = 'ALREADY_REVERSED',  
  AmountMismatch = 'AMOUNT_MISMATCH',  

  InternalError = 'INTERNAL_ERROR',
}