import Constants from "expo-constants";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const T3_CODE_BRAND_MARK_SOURCE =
  appVariant === "development"
    ? require("../../../../assets/dev/blueprint-ios-1024.png")
    : // Fork: production uses the nightly icon, like the app icon.
      require("../../../../assets/nightly/nightly-ios-1024.png");
