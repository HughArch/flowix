/// Cloud target used by the desktop application.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudEnvironment {
    Staging,
    Prod,
}

impl CloudEnvironment {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::Prod => "prod",
        }
    }

    pub const fn api_base(self) -> &'static str {
        match self {
            Self::Staging => "https://staging-cloud.flowix.cc",
            Self::Prod => "https://cloud.flowix.cc",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "staging" => Some(Self::Staging),
            "prod" => Some(Self::Prod),
            _ => None,
        }
    }
}

pub fn default_cloud_environment() -> CloudEnvironment {
    CloudEnvironment::parse(env!("FLOWIX_CLOUD_ENVIRONMENT"))
        .unwrap_or(CloudEnvironment::Prod)
}
