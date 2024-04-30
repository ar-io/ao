use std::env;
use std::fs;
use dotenv::dotenv;

use crate::domain::Config;

#[derive(Debug)]
pub struct AoConfig {
    pub database_url: String,
    pub gateway_url: String,
    pub upload_node_url: String,
    pub mode: String,
    pub scheduler_list_path: String,
    su_wallet_path: Option<String>,
    su_wallet: Option<String>,
}

impl AoConfig {
    pub fn new(mode: Option<String>) -> Result<Self, env::VarError> {
        dotenv().ok();
        let mode_out = match mode {
            Some(m) => m,
            None => env::var("MODE")?,
        };
        Ok(AoConfig {
            database_url: env::var("DATABASE_URL")?,
            su_wallet_path: env::var("SU_WALLET_PATH").ok(),
            su_wallet: env::var("SU_WALLET").ok(),
            gateway_url: env::var("GATEWAY_URL")?,
            upload_node_url: env::var("UPLOAD_NODE_URL")?,
            mode: mode_out,
            scheduler_list_path: env::var("SCHEDULER_LIST_PATH")?,
        })
    }

    pub fn su_wallet(&self) -> String {
        if let Some(wallet) = self.su_wallet.as_ref() {
            // If su_wallet is present, parse it and return as JSON string
            match serde_json::from_str::<serde_json::Value>(wallet) {
                Ok(parsed) => parsed.to_string(),
                Err(err) => panic!("Failed to parse SU_WALLET JSON: {}", err),
            }
        } else if let Some(wallet_path) = self.su_wallet_path.as_ref() {
            // If su_wallet is not present but su_wallet_path is, read from the file
            match fs::read_to_string(wallet_path) {
                Ok(content) => content.trim().to_string(),
                Err(_) => panic!("Failed to read SU_WALLET_PATH from file system"),
            }
        } else {
            panic!("Neither SU_WALLET nor SU_WALLET_PATH is set. Please set one.");
        }
    }
}

impl Config for AoConfig {
    fn su_wallet_path(&self) -> Option<String> {
        self.su_wallet_path.clone()
    }
    fn su_wallet(&self) -> Option<String> {
        self.su_wallet.clone()
    }
    fn upload_node_url(&self) -> String {
        self.upload_node_url.clone()
    }
    fn gateway_url(&self) -> String {
        self.gateway_url.clone()
    }
    fn mode(&self) -> String {
        self.mode.clone()
    }
    fn scheduler_list_path(&self) -> String {
        self.scheduler_list_path.clone()
    }
}
