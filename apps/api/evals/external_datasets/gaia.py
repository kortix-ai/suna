"""
GAIA Benchmark Dataset Loader

GAIA is a benchmark for evaluating next-generation LLMs with augmented capabilities
(tooling, search, etc). It has 3 levels of difficulty.

Dataset: https://huggingface.co/datasets/gaia-benchmark/GAIA
"""

import os
import sys
import json
import shutil
from pathlib import Path
from typing import List, Optional, Dict, Any
from dataclasses import dataclass
import structlog

logger = structlog.get_logger(__name__)

# Cache directory for downloaded datasets - use home directory to avoid conflicts
CACHE_DIR = Path.home() / ".cache" / "suna_evals" / "datasets"

def _cleanup_conflicting_folder():
    """Remove any 'datasets' folder in evals/ that might conflict with imports."""
    evals_dir = Path(__file__).parent.parent
    datasets_folder = evals_dir / "datasets"
    if datasets_folder.exists() and datasets_folder.is_dir():
        try:
            shutil.rmtree(datasets_folder)
            logger.debug(f"Removed conflicting datasets folder: {datasets_folder}")
        except Exception as e:
            logger.warning(f"Could not remove datasets folder: {e}")


@dataclass
class GAIAQuestion:
    """A single GAIA benchmark question."""
    task_id: str
    question: str
    level: int
    final_answer: str
    file_name: Optional[str] = None
    file_path: Optional[str] = None
    annotator_metadata: Optional[Dict[str, Any]] = None


def _ensure_gaia_downloaded() -> Path:
    """Download GAIA dataset if not already cached."""
    gaia_dir = CACHE_DIR / "gaia-benchmark"
    
    if gaia_dir.exists() and (gaia_dir / "2023").exists():
        logger.info(f"GAIA dataset found in cache: {gaia_dir}")
        return gaia_dir
    
    logger.info("Downloading GAIA dataset from HuggingFace...")
    
    try:
        from huggingface_hub import snapshot_download
        try:
            from huggingface_hub.errors import GatedRepoError
        except ImportError:
            from huggingface_hub.utils._errors import GatedRepoError
        
        # Create cache directory
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        
        # Download the dataset
        data_dir = snapshot_download(
            repo_id="gaia-benchmark/GAIA",
            repo_type="dataset",
            local_dir=gaia_dir,
        )
        
        logger.info(f"GAIA dataset downloaded to: {data_dir}")
        return Path(data_dir)
        
    except ImportError:
        raise ImportError(
            "huggingface_hub is required for GAIA dataset. "
            "Install with: uv add huggingface_hub datasets"
        )
    except GatedRepoError:
        raise PermissionError(
            "\n"
            "═══════════════════════════════════════════════════════════════════\n"
            "  GAIA is a GATED DATASET - Authentication required!\n"
            "═══════════════════════════════════════════════════════════════════\n"
            "\n"
            "  To access GAIA benchmark, you need to:\n"
            "\n"
            "  1. Create a HuggingFace account: https://huggingface.co/join\n"
            "\n"
            "  2. Request access to GAIA dataset:\n"
            "     https://huggingface.co/datasets/gaia-benchmark/GAIA\n"
            "     (Click 'Access repository' button)\n"
            "\n"
            "  3. Create an access token:\n"
            "     https://huggingface.co/settings/tokens\n"
            "\n"
            "  4. Login via CLI:\n"
            "     huggingface-cli login\n"
            "\n"
            "  Or set environment variable:\n"
            "     export HF_TOKEN=hf_your_token_here\n"
            "\n"
            "═══════════════════════════════════════════════════════════════════\n"
        )
    except Exception as e:
        logger.error(f"Failed to download GAIA dataset: {e}")
        raise


def load_gaia_dataset(
    level: int = 1,
    split: str = "validation",  # "validation" (public) or "test" (private answers)
    count: Optional[int] = None,
    year: str = "2023",
) -> List[GAIAQuestion]:
    """
    Load GAIA benchmark questions.
    
    Args:
        level: Difficulty level (1, 2, or 3)
        split: "validation" for dev set, "test" for test set
        count: Maximum number of questions to load (None for all)
        year: Dataset year (default "2023")
    
    Returns:
        List of GAIAQuestion objects
    """
    # Clean up any conflicting folders first
    _cleanup_conflicting_folder()
    
    if level not in [1, 2, 3]:
        raise ValueError(f"Level must be 1, 2, or 3, got {level}")
    
    if split not in ["validation", "test"]:
        raise ValueError(f"Split must be 'validation' or 'test', got {split}")
    
    data_dir = _ensure_gaia_downloaded()
    
    try:
        import datasets as hf_datasets
        load_dataset = hf_datasets.load_dataset
        
        # Load the specific level
        config_name = f"{year}_level{level}"
        logger.info(f"Loading GAIA {config_name} {split} split...")
        
        dataset = load_dataset(
            str(data_dir),
            config_name,
            split=split,
            trust_remote_code=True,
        )
        
        questions = []
        for i, example in enumerate(dataset):
            if count and i >= count:
                break
            
            # Build file path if there's an attachment
            file_path = None
            if example.get("file_path"):
                file_path = str(data_dir / example["file_path"])
            
            question = GAIAQuestion(
                task_id=example.get("task_id", f"gaia-{level}-{i}"),
                question=example["Question"],
                level=example.get("Level", level),
                final_answer=example.get("Final answer", ""),
                file_name=example.get("file_name"),
                file_path=file_path,
                annotator_metadata=example.get("Annotator Metadata"),
            )
            questions.append(question)
        
        logger.info(f"Loaded {len(questions)} GAIA level {level} questions")
        return questions
        
    except Exception as e:
        logger.error(f"Failed to load GAIA dataset: {e}")
        # Fall back to loading from parquet/jsonl directly
        return _load_gaia_fallback(data_dir, level, split, count, year)


def _load_gaia_fallback(
    data_dir: Path,
    level: int,
    split: str,
    count: Optional[int],
    year: str,
) -> List[GAIAQuestion]:
    """Fallback loader using direct file access."""
    import pandas as pd
    
    # Try parquet first
    parquet_path = data_dir / year / split / f"metadata.level{level}.parquet"
    if not parquet_path.exists():
        parquet_path = data_dir / year / split / "metadata.parquet"
    
    if parquet_path.exists():
        logger.info(f"Loading from parquet: {parquet_path}")
        df = pd.read_parquet(parquet_path)
        # Only filter if loading from combined parquet (Level column might be string or int)
        if "Level" in df.columns and "level" not in str(parquet_path):
            # Handle both string and int Level values
            df = df[(df["Level"] == level) | (df["Level"] == str(level))]
    else:
        # Try JSONL
        jsonl_path = data_dir / year / split / "metadata.jsonl"
        if not jsonl_path.exists():
            raise FileNotFoundError(f"No GAIA data found at {data_dir}")
        
        logger.info(f"Loading from JSONL: {jsonl_path}")
        records = []
        with open(jsonl_path, "r") as f:
            for line in f:
                record = json.loads(line)
                if record.get("Level", 1) == level:
                    records.append(record)
        df = pd.DataFrame(records)
    
    if count:
        df = df.head(count)
    
    questions = []
    for idx, row in df.iterrows():
        # Handle file path
        file_path_val = row.get("file_path") if hasattr(row, 'get') else row["file_path"] if "file_path" in row.index else None
        full_file_path = None
        if file_path_val and pd.notna(file_path_val) and str(file_path_val).strip():
            full_file_path = str(data_dir / file_path_val)
        
        # Extract fields safely
        task_id = row["task_id"] if "task_id" in row.index else f"gaia-{level}-{len(questions)}"
        question_text = row["Question"]
        level_val = row["Level"] if "Level" in row.index else level
        final_answer = row["Final answer"] if "Final answer" in row.index else ""
        file_name_val = row["file_name"] if "file_name" in row.index else None
        annotator_metadata = row["Annotator Metadata"] if "Annotator Metadata" in row.index else None
        
        question = GAIAQuestion(
            task_id=task_id,
            question=question_text,
            level=level_val,
            final_answer=str(final_answer) if pd.notna(final_answer) else "",
            file_name=file_name_val if pd.notna(file_name_val) else None,
            file_path=full_file_path,
            annotator_metadata=annotator_metadata,
        )
        questions.append(question)
    
    logger.info(f"Loaded {len(questions)} GAIA level {level} questions from fallback")
    return questions


def gaia_to_eval_cases(questions: List[GAIAQuestion]) -> List[Dict[str, Any]]:
    """
    Convert GAIA questions to our eval case format.
    
    Returns list of dicts compatible with Braintrust Eval.
    """
    cases = []
    for q in questions:
        # Build the input prompt
        input_text = q.question
        if q.file_path and os.path.exists(q.file_path):
            input_text += f"\n\n[Attached file: {q.file_name or 'file'}]"
        
        case = {
            "input": input_text,
            "expected": q.final_answer,
            "metadata": {
                "task_id": q.task_id,
                "level": q.level,
                "file_path": q.file_path,
                "file_name": q.file_name,
                "source": "gaia",
            },
            "tags": [f"gaia-level{q.level}", "benchmark"],
        }
        cases.append(case)
    
    return cases


# Convenience functions for each level
def load_gaia_level1(count: Optional[int] = None) -> List[Dict[str, Any]]:
    """Load GAIA Level 1 (easiest) questions."""
    questions = load_gaia_dataset(level=1, count=count)
    return gaia_to_eval_cases(questions)


def load_gaia_level2(count: Optional[int] = None) -> List[Dict[str, Any]]:
    """Load GAIA Level 2 (medium) questions."""
    questions = load_gaia_dataset(level=2, count=count)
    return gaia_to_eval_cases(questions)


def load_gaia_level3(count: Optional[int] = None) -> List[Dict[str, Any]]:
    """Load GAIA Level 3 (hardest) questions."""
    questions = load_gaia_dataset(level=3, count=count)
    return gaia_to_eval_cases(questions)


if __name__ == "__main__":
    # Test loading
    print("Testing GAIA dataset loader...")
    questions = load_gaia_level1(count=3)
    for q in questions:
        print(f"\n--- {q['metadata']['task_id']} ---")
        print(f"Q: {q['input'][:200]}...")
        print(f"A: {q['expected']}")

