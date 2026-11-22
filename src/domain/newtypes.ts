import { iso, type Newtype } from 'newtype-ts';

export type IssueNumber = Newtype<{ readonly IssueNumber: unique symbol }, number>;
export type PrNumber = Newtype<{ readonly PrNumber: unique symbol }, number>;
export type Count = Newtype<{ readonly Count: unique symbol }, number>;

export type Title = Newtype<{ readonly Title: unique symbol }, string>;
export type Body = Newtype<{ readonly Body: unique symbol }, string>;
export type Message = Newtype<{ readonly Message: unique symbol }, string>;
export type LabelName = Newtype<{ readonly LabelName: unique symbol }, string>;
export type BranchName = Newtype<{ readonly BranchName: unique symbol }, string>;
export type IsoTimestamp = Newtype<{ readonly IsoTimestamp: unique symbol }, string>;
export type HexColor = Newtype<{ readonly HexColor: unique symbol }, string>;
export type FieldOptionName = Newtype<{ readonly FieldOptionName: unique symbol }, string>;
export type ReviewerName = Newtype<{ readonly ReviewerName: unique symbol }, string>;
export type PlanNodeId = Newtype<{ readonly PlanNodeId: unique symbol }, string>;

export const isoIssueNumber = iso<IssueNumber>();
export const isoPrNumber = iso<PrNumber>();
export const isoCount = iso<Count>();
export const isoTitle = iso<Title>();
export const isoBody = iso<Body>();
export const isoMessage = iso<Message>();
export const isoLabelName = iso<LabelName>();
export const isoBranchName = iso<BranchName>();
export const isoIsoTimestamp = iso<IsoTimestamp>();
export const isoHexColor = iso<HexColor>();
export const isoFieldOptionName = iso<FieldOptionName>();
export const isoReviewerName = iso<ReviewerName>();
export const isoPlanNodeId = iso<PlanNodeId>();
