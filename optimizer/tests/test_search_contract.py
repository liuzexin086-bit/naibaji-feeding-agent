import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from contracts import FIELD_ORDER, SCHEMA_VERSION
from search import (
    build_search_output,
    data_digest,
    generate_batches,
    local_refine,
    random_search,
)


class SearchContractTest(unittest.TestCase):
    def test_fixed_seed_search_and_refine_are_reproducible(self) -> None:
        batches = generate_batches(3, seed=7)
        first, first_loss, first_results = random_search(batches, n_trials=12, seed=99)
        second, second_loss, second_results = random_search(batches, n_trials=12, seed=99)
        self.assertEqual(first, second)
        self.assertEqual(first_loss, second_loss)
        self.assertEqual(first_results, second_results)

        refined_first, refined_loss, refined_results = local_refine(
            batches, first, n_trials=8, seed=77
        )
        refined_second, refined_second_loss, refined_second_results = local_refine(
            batches, second, n_trials=8, seed=77
        )
        self.assertEqual(refined_first, refined_second)
        self.assertEqual(refined_loss, refined_second_loss)
        self.assertEqual(refined_results, refined_second_results)

    def test_search_output_has_named_fields_units_and_schema(self) -> None:
        batches = generate_batches(2, seed=5)
        best, _, all_results = random_search(batches, n_trials=5, seed=9)
        refined, _, refine_results = local_refine(batches, best, n_trials=4, seed=11)
        output = build_search_output(
            batches,
            refined,
            (1.0, 100.0, 0.05),
            (0.5, 120.0, 0.04),
            all_results,
            refine_results,
        )
        self.assertEqual(output["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(output["parameters"]["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(
            list(output["parameters"]["parameters"].keys()),
            list(FIELD_ORDER),
        )
        self.assertEqual(
            list(output["parameters"]["units"].keys()),
            list(FIELD_ORDER),
        )
        self.assertEqual(output["parameters"]["units"]["threshold"], "grams-per-head")
        self.assertEqual(output["parameters"]["units"]["dilution"], "water-to-powder ratio")
        self.assertIn("modelVersion", output)
        self.assertIn("seed", output)
        self.assertIn("dataSummary", output)
        self.assertEqual(output["dataSummary"]["dataSha256"], data_digest(batches))
        for row in output["search_results"]:
            self.assertEqual(
                list(row["parameters"]["parameters"].keys()),
                list(FIELD_ORDER),
            )


if __name__ == "__main__":
    unittest.main()
